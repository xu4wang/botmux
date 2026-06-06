/**
 * Daemon-driven v3 run — the Feishu-product execution path (vs `cli-run.ts`'s
 * dev/dogfood terminal path).  Mirrors v0.2's `driveWorkflowRun`, but for the
 * v3 engine and with **suspend-mode gates**:
 *
 *   - `gateMode:'suspend'`: when a humanGate is reached the runtime writes the
 *     pending wait file + returns `awaitingGate` WITHOUT awaiting a decision —
 *     no in-memory promise to lose on a daemon restart.
 *   - This driver posts the approval card(s) for each pending gate and returns.
 *     It does NOT hold the run.  A card click resolves the wait (+ appends
 *     `gateResolved`) and RE-INVOKES `driveV3Run` for a fresh replay that picks
 *     up the now-`gateCleared` node and continues.
 *
 * Stateless by design (recovery source = runDir dag/journal/wait/chatBinding).
 * The daemon owns a lightweight per-runId in-flight guard around this so two
 * concurrent clicks / start can't double-spawn.
 */

import { join } from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';

import { loadBotConfigs, type BotConfig } from '../../bot-registry.js';
import { loadDag } from './dag.js';
import {
  runWorkflow,
  nextAttemptIdFor,
  latestAttemptIdFor,
  type V3RuntimeDeps,
  type V3RuntimeOptions,
  type V3RunOutcome,
  type V3PendingGate,
} from './runtime.js';
import { createEphemeralPool } from './ephemeral-pool.js';
import { readAndValidateManifest, ManifestValidationError } from './manifest.js';
import {
  readGrillState,
  defaultBaseDir,
  type RunChatBinding,
} from './grill-state.js';
import { resolveBotConfig, botToSnapshot } from './bot-resolve.js';
import { readWait, resolveWait, writePendingWait, type GateWaitStatus } from './human-gate.js';
import { readJournal, appendEvent, type StoredEvent, type V3ErrorClass } from './journal.js';
import { materialize } from './state.js';
import { isValidRunId } from './ops-projection.js';
import type { ValidateManifest } from './contract.js';

/**
 * runId → runDir with a path-traversal guard (codex review #2).  runIds reach
 * the daemon from outside (start IPC, card clicks) — never trust them into a
 * `join` without the allowlist check, so the guard lives in core (not glue).
 */
export function safeRunDir(baseDir: string, runId: string): string {
  if (!isValidRunId(runId)) throw new Error(`v3: invalid runId "${runId}"`);
  return join(baseDir, runId);
}

export type V3TerminalOutcome = Extract<V3RunOutcome, { reason: 'terminal' }>;

/** What the daemon needs to render a blocked-node retry card. */
export interface V3BlockedInfo {
  nodeId: string;
  attemptId: string;
  errorClass?: V3ErrorClass;
  errorCode?: string;
  message?: string;
}

/** Latest `nodeBlocked` details for a node (card content).  Falls back to a
 *  bare nodeId/attempt when the journal has no blocked event (shouldn't
 *  happen for a blocked run, but the card must still render). */
export function blockedInfoFor(events: StoredEvent[], nodeId: string): V3BlockedInfo {
  let found: V3BlockedInfo | undefined;
  for (const e of events) {
    if (e.type === 'nodeBlocked' && e.nodeId === nodeId) {
      found = {
        nodeId,
        attemptId: e.attemptId,
        errorClass: e.errorClass,
        errorCode: e.errorCode,
        message: e.message,
      };
    }
  }
  return found ?? { nodeId, attemptId: latestAttemptIdFor(events, nodeId) ?? `${nodeId}/attempts/001` };
}

export interface V3DaemonRunDeps {
  /** runs root (default ~/.botmux/v3-runs). */
  baseDir?: string;
  /** bot config source (default live bots.json) — injectable for tests. */
  loadBots?: () => BotConfig[];
  /** Build the ephemeral pool's runNode — injectable for tests. Default = real pool. */
  makeRunNode?: (resolveLarkAppSecret: (larkAppId: string) => string | undefined) => V3RuntimeDeps['runNode'];
  /** Manifest validator — injectable for tests. Default = real readAndValidateManifest wrapper. */
  validateManifest?: ValidateManifest;
  /** Post (or re-post) a humanGate approval card for a pending gate to the bound topic. */
  postGateCard: (binding: RunChatBinding, gate: V3PendingGate, runId: string) => Promise<void>;
  /** Post a blocked-node retry card.  Optional — when absent (or no binding),
   *  a blocked outcome falls through to `onTerminal` like failed/succeeded. */
  postBlockedCard?: (binding: RunChatBinding, info: V3BlockedInfo, runId: string) => Promise<void>;
  /** Report a terminal run (final card / message).  Optional. */
  onTerminal?: (runId: string, outcome: V3TerminalOutcome, binding?: RunChatBinding) => Promise<void>;
  maxParallel?: number;
}

/**
 * Drive a daemon-side v3 run to its next suspension point (a gate) or terminal.
 * Returns the runtime outcome.  Throws on: missing grill state, no approved
 * dag, or awaitingGate with no chatBinding (can't post a card).
 */
export async function driveV3Run(runId: string, deps: V3DaemonRunDeps): Promise<V3RunOutcome> {
  const baseDir = deps.baseDir ?? defaultBaseDir();
  const runDir = safeRunDir(baseDir, runId);

  const grill = readGrillState(runDir);
  if (!grill) throw new Error(`v3 daemon run: no grill state for "${runId}" in ${runDir}`);
  if (!grill.dagPath || !existsSync(grill.dagPath)) {
    throw new Error(`v3 daemon run: "${runId}" has no approved dag (status=${grill.status})`);
  }
  const binding = grill.chatBinding;

  const bots = (deps.loadBots ?? loadBotConfigs)();
  // Secret resolver by larkAppId from live bots.json; no env fallback (contract).
  const secretById = new Map(bots.map((b) => [b.larkAppId, b.larkAppSecret]));
  const resolveLarkAppSecret = (larkAppId: string): string | undefined => secretById.get(larkAppId);

  // codex's throw-based validator → runtime's result-style seam (override-able for tests).
  const validateManifest: ValidateManifest = deps.validateManifest ?? (async (manifestPath, outputDir) => {
    try {
      const manifest = await readAndValidateManifest(manifestPath, outputDir);
      return { ok: true, manifest };
    } catch (e) {
      return { ok: false, problems: e instanceof ManifestValidationError ? e.problems : [String(e)] };
    }
  });

  const resolveBotSnapshot = (botId: string | undefined) => botToSnapshot(resolveBotConfig(botId, bots));

  const runNode = (deps.makeRunNode ?? defaultMakeRunNode)(resolveLarkAppSecret);
  const dag = loadDag(grill.dagPath);

  // suspend mode → no resolveGate (runtime writes the wait + returns awaitingGate).
  const runtimeDeps: V3RuntimeDeps = { runNode, validateManifest, resolveBotSnapshot };
  const opts: V3RuntimeOptions = {
    baseDir,
    gateMode: 'suspend',
    ...(deps.maxParallel ? { globalConcurrency: deps.maxParallel } : {}),
  };

  const outcome = await runWorkflow(dag, runtimeDeps, opts);

  if (outcome.reason === 'awaitingGate') {
    if (!binding) {
      // No chat binding (e.g. not born via grill) → can't post a card.  The
      // wait files are on disk; surface rather than silently strand the run.
      throw new Error(
        `v3 daemon run "${runId}" is awaiting gate(s) but has no chatBinding — cannot post approval card`,
      );
    }
    for (const gate of outcome.pendingWaits) {
      await deps.postGateCard(binding, gate, runId);
    }
  } else if (outcome.runStatus === 'blocked' && outcome.blockedNodeId && binding && deps.postBlockedCard) {
    // Blocked = terminal-for-now: post the retry card instead of a final
    // notification.  A click appends `nodeRetryRequested` + re-drives.
    const events = readJournal(join(runDir, 'journal.ndjson'));
    await deps.postBlockedCard(binding, blockedInfoFor(events, outcome.blockedNodeId), runId);
  } else {
    await deps.onTerminal?.(runId, outcome, binding);
  }

  return outcome;
}

function defaultMakeRunNode(
  resolveLarkAppSecret: (larkAppId: string) => string | undefined,
): V3RuntimeDeps['runNode'] {
  const { runNode } = createEphemeralPool({ resolveLarkAppSecret });
  return runNode;
}

export type V3GateClickOutcome =
  | { kind: 'resolved'; resolution: 'approved' | 'rejected' }
  | { kind: 'already-settled'; status: GateWaitStatus }
  | { kind: 'stale-run'; reason: 'terminal' | 'missing' | 'no-wait' };

/**
 * Resolve a humanGate approval-card click.  Idempotent + terminal-safe (codex
 * review #5):
 *   1. run terminal / journal missing → `stale-run` (caller toasts, does NOT
 *      redrive — a finished run must not be pulled back to life by a stale card).
 *   2. wait missing / non-pending → `stale-run`(no-wait) / `already-settled`
 *      (caller toasts, no redrive — guards repeat clicks).
 *   3. pending → `resolveWait` (atomic — THE idempotency guard) THEN append
 *      `gateResolved`.  Returns `resolved` → caller redrives.
 *
 * Order is wait-first on purpose: a crash between the two leaves the wait
 * settled (future clicks → already-settled, no double-resolve); the rare
 * wait-resolved-but-journal-missing gap is healed by cold-attach reconcile.
 * If the journal append throws, this throws — the caller must warn and NOT
 * fake UI success (codex #5).
 */
export function resolveV3GateClick(
  baseDir: string,
  runId: string,
  input: { waitId: string; resolution: 'approved' | 'rejected'; by: string },
): V3GateClickOutcome {
  const runDir = safeRunDir(baseDir, runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'stale-run', reason: 'missing' };
  const snap = materialize(readJournal(journalPath));
  if (snap.runStatus !== 'running') return { kind: 'stale-run', reason: 'terminal' };

  const wait = readWait(runDir, input.waitId);
  if (!wait) return { kind: 'stale-run', reason: 'no-wait' };
  if (wait.status !== 'pending') return { kind: 'already-settled', status: wait.status };

  resolveWait(runDir, input.waitId, input.resolution, input.by);
  appendEvent(journalPath, {
    type: 'gateResolved',
    // nodeId from the WAIT FILE, not caller input (codex review #1): the wait is
    // the authoritative state — a wrong/stale caller nodeId must not let us write
    // gateResolved for a different node.
    nodeId: wait.nodeId,
    waitId: input.waitId,
    resolution: input.resolution,
    by: input.by,
  });
  return { kind: 'resolved', resolution: input.resolution };
}

export type V3RetryOutcome =
  | { kind: 'requested'; nodeId: string; previousAttemptId: string; nextAttemptId: string }
  | { kind: 'already-requested'; nodeId: string }
  | { kind: 'stale-run'; reason: 'missing' | 'not-blocked' | 'stale-attempt' };

/**
 * Append a retry intent for a blocked node (the resume entrypoint — daemon
 * card click and `botmux workflow retry` both land here).  Recovery-first +
 * idempotent (codex v2 of the blocked design):
 *   1. fresh `materialize(readJournal)` — the journal is the recovery source;
 *      a node that already succeeded / re-dispatched is seen as such.
 *   2. the target node must STILL be materialized `blocked`.  A node already
 *      reset to pending by an unconsumed `nodeRetryRequested` → already-requested
 *      (no second append); anything else → stale.
 *   3. `expectedAttemptId` (card clicks pass the card's attempt): the retry is
 *      only valid for the attempt that is CURRENTLY blocked — a stale card from
 *      attempt 001 must not advance attempt 002's blocked to 003 (codex
 *      blocker, slice-1 review).  The card nonce alone only proves the card's
 *      own integrity, not freshness.  CLI omits it ("retry whatever is blocked").
 *   4. append `nodeRetryRequested` with the reserved nextAttemptId and the
 *      previous blocked event's errorClass/errorCode copied in for audit.
 * The caller re-drives (materialize folds the retry into pending → orchestrator
 * re-dispatches with the reserved attempt number).
 */
export function requestV3Retry(
  baseDir: string,
  runId: string,
  input: { nodeId?: string; expectedAttemptId?: string } = {},
): V3RetryOutcome {
  const runDir = safeRunDir(baseDir, runId);
  const journalPath = join(runDir, 'journal.ndjson');
  if (!existsSync(journalPath)) return { kind: 'stale-run', reason: 'missing' };

  const events = readJournal(journalPath);
  const snap = materialize(events);
  // Target resolution: explicit nodeId > the run's blocked pointer > a node
  // with an unconsumed retry reservation (a prior retry already cleared the
  // blocked pointer — the idempotent repeat-call path).
  const nodeId =
    input.nodeId ??
    snap.blockedNodeId ??
    [...snap.nodes.keys()].find((id) => unconsumedRetryEvent(events, id) !== undefined);
  if (!nodeId) return { kind: 'stale-run', reason: 'not-blocked' };

  const status = snap.nodes.get(nodeId)?.status;
  if (status === 'pending') {
    // An unconsumed retry reservation already reset this node — idempotent
    // no-op (a second click / a CLI retry racing the card must not double-append).
    const pendingRetry = unconsumedRetryEvent(events, nodeId);
    if (pendingRetry) {
      // The repeat-call is only "the same retry" when it references the attempt
      // that retry was FOR — a stale older card is not an idempotent repeat.
      if (input.expectedAttemptId && input.expectedAttemptId !== pendingRetry.previousAttemptId) {
        return { kind: 'stale-run', reason: 'stale-attempt' };
      }
      return { kind: 'already-requested', nodeId };
    }
    return { kind: 'stale-run', reason: 'not-blocked' };
  }
  if (status !== 'blocked') return { kind: 'stale-run', reason: 'not-blocked' };

  const previousAttemptId = latestAttemptIdFor(events, nodeId);
  if (!previousAttemptId) return { kind: 'stale-run', reason: 'not-blocked' };
  const info = blockedInfoFor(events, nodeId);
  // Freshness gate (codex blocker): the click must target the CURRENTLY
  // blocked attempt, not an earlier one whose card survived in the chat.
  if (input.expectedAttemptId && input.expectedAttemptId !== info.attemptId) {
    return { kind: 'stale-run', reason: 'stale-attempt' };
  }
  const nextAttemptId = nextAttemptIdFor(events, nodeId);

  appendEvent(journalPath, {
    type: 'nodeRetryRequested',
    nodeId,
    previousAttemptId,
    nextAttemptId,
    reason: 'blockedRetry',
    previousErrorClass: info.errorClass,
    previousErrorCode: info.errorCode,
  });
  return { kind: 'requested', nodeId, previousAttemptId, nextAttemptId };
}

/** The node's `nodeRetryRequested` whose reserved attempt has not yet been
 *  consumed by a matching `nodeDispatched` (undefined when none pending). */
function unconsumedRetryEvent(
  events: StoredEvent[],
  nodeId: string,
): Extract<StoredEvent, { type: 'nodeRetryRequested' }> | undefined {
  let pending: Extract<StoredEvent, { type: 'nodeRetryRequested' }> | undefined;
  for (const e of events) {
    if (e.type === 'nodeRetryRequested' && e.nodeId === nodeId) pending = e;
    else if (e.type === 'nodeDispatched' && e.nodeId === nodeId && e.attemptId === pending?.nextAttemptId) {
      pending = undefined;
    }
  }
  return pending;
}

export interface V3GateRecovery {
  runId: string;
  runDir: string;
  binding?: RunChatBinding;
  /** pending gates whose approval card the daemon should (re)post. */
  repost: V3PendingGate[];
  /** blocked node whose retry card the daemon should (re)post — covers the
   *  crash window between the `runBlocked` append and the card send. */
  repostBlocked?: V3BlockedInfo;
  /** true when a resolved-but-unjournaled gate was healed → daemon should driveV3Run. */
  resume: boolean;
}

export interface V3GateRunnerDeps {
  baseDir?: string;
  /** Post (or re-post) a gate's approval card to its topic.  The daemon builds
   *  the card + sends via Lark (kept here so this module has no `im/` import). */
  postCard: (binding: RunChatBinding, gate: V3PendingGate, runId: string) => Promise<void>;
  /** Post (or re-post) a blocked node's retry card. */
  postBlockedCard?: (binding: RunChatBinding, info: V3BlockedInfo, runId: string) => Promise<void>;
  /** Notify a terminal run (optional, daemon-supplied). */
  notifyTerminal?: (binding: RunChatBinding | undefined, runId: string, outcome: V3TerminalOutcome) => Promise<void>;
  /** runtime deps passthrough (tests inject; daemon uses real pool). */
  loadBots?: V3DaemonRunDeps['loadBots'];
  makeRunNode?: V3DaemonRunDeps['makeRunNode'];
  validateManifest?: V3DaemonRunDeps['validateManifest'];
  maxParallel?: number;
  /** error sink (default: swallow).  Daemon passes its logger.warn. */
  onError?: (runId: string, err: unknown) => void;
}

/**
 * The daemon's v3 gate run-controller: an in-flight-guarded `drive(runId)`
 * (mirrors v0.2's driveWorkflowRun re-entry) + a `coldAttach()` that re-arms
 * pending gates on startup.  Stateless except the in-flight set — recovery
 * source is always the runDir.
 */
export function createV3GateRunner(deps: V3GateRunnerDeps) {
  const inFlight = new Set<string>();
  const rerunRequested = new Set<string>();

  async function drive(runId: string): Promise<void> {
    // Coalesce (codex blocker #2): if a drive is already in flight for this run,
    // DON'T silently no-op — a click that resolved a gate + called driveDetached
    // while the prior drive was busy (e.g. slow postCard) would otherwise be
    // dropped and the run would stall at gateCleared/pending.  Mark a rerun and
    // let the active drive loop pick it up after it finishes.
    if (inFlight.has(runId)) {
      rerunRequested.add(runId);
      return;
    }
    inFlight.add(runId);
    try {
      do {
        rerunRequested.delete(runId); // clear before the run; a request DURING re-sets it
        await driveV3Run(runId, {
          baseDir: deps.baseDir,
          loadBots: deps.loadBots,
          makeRunNode: deps.makeRunNode,
          validateManifest: deps.validateManifest,
          maxParallel: deps.maxParallel,
          postGateCard: (binding, gate, rid) => deps.postCard(binding, gate, rid),
          postBlockedCard: deps.postBlockedCard,
          onTerminal: (rid, outcome, binding) =>
            deps.notifyTerminal ? deps.notifyTerminal(binding, rid, outcome) : Promise.resolve(),
        });
      } while (rerunRequested.has(runId));
    } catch (err) {
      deps.onError?.(runId, err);
    } finally {
      inFlight.delete(runId);
      rerunRequested.delete(runId);
    }
  }

  /** Fire-and-forget drive (card-click / start IPC call this). */
  function driveDetached(runId: string): void {
    void drive(runId);
  }

  async function coldAttach(ownerLarkAppId?: string): Promise<void> {
    let recs: V3GateRecovery[] = [];
    try {
      recs = reconcileV3PendingGates(deps.baseDir, ownerLarkAppId);
    } catch (err) {
      deps.onError?.('(cold-attach)', err);
      return;
    }
    for (const rec of recs) {
      if (rec.binding) {
        for (const gate of rec.repost) {
          try {
            await deps.postCard(rec.binding, gate, rec.runId);
          } catch (err) {
            deps.onError?.(rec.runId, err);
          }
        }
        if (rec.repostBlocked && deps.postBlockedCard) {
          try {
            await deps.postBlockedCard(rec.binding, rec.repostBlocked, rec.runId);
          } catch (err) {
            deps.onError?.(rec.runId, err);
          }
        }
      }
      if (rec.resume) driveDetached(rec.runId);
    }
  }

  return { drive, driveDetached, coldAttach };
}

/**
 * Cold-attach reconcile (daemon startup, codex review #2/#3).  Finds v3 runs
 * suspended at a humanGate and reconciles the journal↔wait-file atomic window
 * BOTH ways:
 *   - node `gateWaiting` + wait file MISSING (crash between the `gateDispatched`
 *     append and `writePendingWait`) → re-create the pending wait from the
 *     dag's `humanGate.prompt`, then repost a card.
 *   - node `gateWaiting` + wait RESOLVED (crash between `resolveWait` and the
 *     `gateResolved` append) → append the missing `gateResolved` → resume.
 *   - node `gateWaiting` + wait pending → just repost a card.
 * Skips terminal runs.  Pure file IO + journal append — the daemon decides what
 * to post / drive from the returned list.
 */
export function reconcileV3PendingGates(baseDir: string = defaultBaseDir(), ownerLarkAppId?: string): V3GateRecovery[] {
  if (!existsSync(baseDir)) return [];
  const out: V3GateRecovery[] = [];
  for (const runId of readdirSync(baseDir)) {
    if (!isValidRunId(runId)) continue; // skip non-run dirs / unsafe names (codex #2)
    const runDir = join(baseDir, runId);
    try {
      if (!statSync(runDir).isDirectory()) continue;
      const journalPath = join(runDir, 'journal.ndjson');
      if (!existsSync(journalPath)) continue;

      const events = readJournal(journalPath);
      const snap = materialize(events);
      if (snap.runStatus === 'succeeded' || snap.runStatus === 'failed') continue;

      if (snap.runStatus === 'blocked') {
        // Blocked run: repost the retry card (covers the crash window between
        // the runBlocked append and the original card send).  Owner-filtered
        // like gates; binding-less (CLI/dev) runs are left alone.
        const grill = readGrillState(runDir);
        const binding = grill?.chatBinding;
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding || !snap.blockedNodeId) continue;
        out.push({
          runId, runDir, binding,
          repost: [],
          repostBlocked: blockedInfoFor(events, snap.blockedNodeId),
          resume: false,
        });
        continue;
      }

      // runStatus === 'running'
      const rec = reconcileOneRun(runId, runDir, journalPath, snap, ownerLarkAppId);
      if (rec) {
        out.push(rec);
        continue;
      }
      // No gate to reconcile.  If nothing is (phantom-)running, the run died in
      // a resumable spot — e.g. crash right after a `nodeRetryRequested` append
      // (before the redrive) or right after start — so re-drive it.  Runs with
      // phantom `running` nodes are the dangling-attempt recovery gap (worker
      // fencing backlog) and are deliberately left alone.
      const hasRunning = [...snap.nodes.values()].some((s) => s.status === 'running');
      if (!hasRunning) {
        const grill = readGrillState(runDir);
        const binding = grill?.chatBinding;
        if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) continue;
        if (!binding) continue; // CLI/dev runs are not the daemon's to adopt
        out.push({ runId, runDir, binding, repost: [], resume: true });
      }
    } catch {
      // best-effort (codex #3): a single corrupt run (torn journal / bad
      // grill.state / IO error) must not kill the whole cold-attach scan.
      continue;
    }
  }
  return out;
}

function reconcileOneRun(
  runId: string,
  runDir: string,
  journalPath: string,
  snap: ReturnType<typeof materialize>,
  ownerLarkAppId?: string,
): V3GateRecovery | undefined {
  const gateWaitingNodes = [...snap.nodes.entries()]
    .filter(([, s]) => s.status === 'gateWaiting')
    .map(([id]) => id);
  if (gateWaitingNodes.length === 0) return undefined;

  const grill = readGrillState(runDir); // defensive: undefined on corrupt (won't throw)
  const binding = grill?.chatBinding;

  // Multi-daemon owner filter (codex blocker #1): each bot daemon must only
  // touch runs bound to ITS larkAppId — otherwise every online daemon re-posts
  // / resumes the same pending gate.  A run with no binding (CLI/dev) or a
  // different owner is left for the owning daemon (or nobody).
  if (ownerLarkAppId && binding?.larkAppId !== ownerLarkAppId) return undefined;

  // dag (for humanGate.prompt when re-creating a missing wait).
  const dagNodePrompt = new Map<string, string>();
  if (grill?.dagPath && existsSync(grill.dagPath)) {
    try {
      for (const n of loadDag(grill.dagPath).nodes) {
        if (n.humanGate?.prompt) dagNodePrompt.set(n.id, n.humanGate.prompt);
      }
    } catch {
      /* dag unreadable — fall back to a generic prompt below */
    }
  }

  const repost: V3PendingGate[] = [];
  let resume = false;
  for (const nodeId of gateWaitingNodes) {
    const waitId = `${nodeId}-gate`;
    let wait = readWait(runDir, waitId);
    if (!wait) {
      const prompt = dagNodePrompt.get(nodeId) ?? '(humanGate — 等待人工审批)';
      wait = writePendingWait(runDir, { waitId, nodeId, prompt });
    }
    if (wait.status === 'pending') {
      repost.push({ nodeId, waitId, prompt: wait.prompt });
    } else {
      // resolved wait but node still gateWaiting → journal lost gateResolved → heal.
      // nodeId from the wait file (authoritative, codex #1).
      appendEvent(journalPath, {
        type: 'gateResolved', nodeId: wait.nodeId, waitId, resolution: wait.status, by: wait.by ?? 'system',
      });
      resume = true;
    }
  }
  return { runId, runDir, binding, repost, resume };
}
