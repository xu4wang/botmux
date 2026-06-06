/**
 * v3 runtime — the scheduling main loop.
 *
 * Ties the pure pieces together against the SHARED contract:
 *   load dag → freeze bot snapshots → init runDir →
 *   { materialize journal → decideNext → dispatch ready work under caps →
 *     await a settle → repeat } until terminal.
 *
 * Every side effect lives here (journal append, STATE checkpoint, dir layout,
 * goal/inputs/env materialization).  The actual worker spawn (`runNode`) and
 * manifest validation (`validateManifest`) are INJECTED — codex's
 * `ephemeral-pool.ts` / `manifest.ts` provide them, but the runtime compiles
 * against the contract types alone so the two halves build independently.
 *
 * MVP scope: static DAG, fail-fast, no retry (always `attempts/001`).  Retry
 * (`attempts/NNN`) and richer cancel semantics are deferred — see
 * `docs/design/2026-06-01-v3-mvp-engine-split.md`.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';

import { DEFAULT_NODE_TIMEOUT_SEC, isGoalNode, type V3Dag, type V3Node, type V3ResultSchema } from './dag.js';
import { decideNext } from './orchestrator.js';
import { appendEvent, readJournal, type StoredEvent, type V3ErrorClass } from './journal.js';
import { materialize, writeState } from './state.js';
import { writePendingWait } from './human-gate.js';
import {
  GOAL_ENV,
  MANIFEST_FILE_KINDS,
  MANIFEST_SCHEMA_VERSION,
  MANIFEST_STATUSES,
  V3_SUPPORTED_CLIS,
  isV3SupportedCli,
  type BotSnapshot,
  type GoalInputs,
  type Manifest,
  type RunNode,
  type RunNodeRequest,
  type ValidateManifest,
} from './contract.js';

// ─── goal.txt rendering ─────────────────────────────────────────────────────

/**
 * Render the self-contained instruction file the goal-mode agent reads via
 * `$BOTMUX_GOAL_PATH`.  The execution contract (read inputs / write products /
 * write the manifest) lives HERE — in a file — rather than inside the `/goal`
 * command text, because a long multi-line `/goal` argument trips Claude Code's
 * paste-detection (the TUI folds it into a "[Pasted text]" blob and the
 * slash-command parser never fires).  The pool's `buildGoalCommand` therefore
 * sends only a short single-line `/goal` that points the agent at this file.
 *
 * Rendered from `contract.ts` constants so the manifest shape stays a single
 * source of truth shared with codex's validator.
 */
export function renderGoalFile(goal: string, resultSchema?: V3ResultSchema): string {
  const E = GOAL_ENV;
  const kinds = MANIFEST_FILE_KINDS.join(' | ');
  const [okStatus, failStatus] = MANIFEST_STATUSES;
  const resultSection = resultSchema
    ? [
        '## Structured result (REQUIRED for this node)',
        `This node declares a structured output contract. Write a JSON file \`result.json\` directly under $${E.OUTPUT_DIR} matching this schema (declared property types are enforced at the top level; every \`required\` field must be present):`,
        '',
        '  ' + JSON.stringify(resultSchema),
        '',
        `List \`result.json\` in the manifest \`files\` array like any other product (its \`path\` is exactly "result.json"). A missing or schema-violating result.json blocks this node.`,
        '',
      ]
    : [];
  return [
    '# botmux v3 节点任务 / botmux v3 node task',
    '',
    '## Goal',
    goal,
    '',
    '## How to complete this node',
    'You are an autonomous agent completing exactly ONE botmux v3 workflow node.',
    'Work toward the goal above until it is done, then stop. Do not ask the user any questions.',
    '',
    `- Upstream inputs: the file at $${E.INPUTS_PATH} is a JSON object \`{ "inputs": [...] }\` listing upstream products, each with an absolute \`path\`. Read only the ones the goal needs (it may be empty).`,
    `- Output: write ALL products under the directory at $${E.OUTPUT_DIR}. Do NOT write anything outside that directory.`,
    `- Manifest (required): before you finish, write a JSON manifest to $${E.MANIFEST_PATH} with exactly this shape:`,
    '',
    '  {',
    `    "schemaVersion": ${MANIFEST_SCHEMA_VERSION},`,
    `    "status": "${okStatus}" | "${failStatus}",`,
    '    "summary": "<one short line>",',
    '    "files": [',
    `      { "name": "<logical name>", "path": "<RELATIVE to the output dir>", "kind": "<${kinds}>", "bytes": <int>, "sha256": "<hex sha256 of the file; empty string \\"\\" for a directory>", "mime": "<mime type>", "preview": "<optional short excerpt>" }`,
    '    ],',
    `    "error": { "code": "...", "message": "...", "retryable": false }`,
    '  }',
    '',
    `  - On success: status "${okStatus}", at least one file entry, and NO \`error\` field.`,
    `  - On failure: status "${failStatus}", \`error\` required, \`files\` may be empty. Set \`error.retryable\` honestly: \`true\` when a human can unblock you and a fresh attempt could then succeed; \`false\` when retrying cannot help.`,
    `  - Every file \`path\` is relative to $${E.OUTPUT_DIR} ITSELF. A file you wrote directly into that directory has a path that is JUST its filename, e.g. \`"path": "report.md"\`. Do NOT prepend the directory or its folder name (NOT \`"work/report.md"\`) and do NOT use an absolute path — both are rejected.`,
    '',
    ...resultSection,
    `You are DONE only after the manifest at $${E.MANIFEST_PATH} exists and every file it references exists.`,
    'If you cannot complete the goal, write a failure manifest and stop.',
    'If you hit an authentication / authorization / interactive-confirmation wall (a login prompt, an expired token, a permission you cannot grant yourself): do NOT wait for a human and do NOT keep retrying. Immediately write a failure manifest with an \`error.code\` like "AUTH_REQUIRED" and \`error.retryable: true\`, then stop — a human will unblock and retry this node.',
    '',
  ].join('\n');
}

// ─── Terminal classification + structured-result validation (pure) ──────────

/**
 * Map a node's failure to its terminal kind (the blocked/failed split):
 *   - `blocked`  = semantic/contract failure — retryable via a new attempt
 *   - `failed`   = infrastructure / human-veto / budget — needs intervention
 *
 * `selfReportedFail` marks the special case where the manifest is structurally
 * VALID but declares `status:'fail'` — then the node's own `error.retryable`
 * decides (`false` → failed; `true`/absent → blocked, the agent presumably
 * knows a human can unblock it).
 */
export function classifyTerminal(
  errorClass: V3ErrorClass,
  opts?: { selfReportedFail?: boolean; retryable?: boolean },
): 'blocked' | 'failed' {
  if (opts?.selfReportedFail) return opts.retryable === false ? 'failed' : 'blocked';
  switch (errorClass) {
    case 'manifestInvalid': // agent wrote a bad manifest — a retry may fix it
    case 'resultInvalid':   // result.json missing/violating — same
      return 'blocked';
    case 'workerError':     // process crash = infrastructure
    case 'timeout':         // budget exceeded = infrastructure (for now)
    case 'gateRejected':    // a human said no — retrying won't change that
    case 'cancelled':
      return 'failed';
  }
}

/** Validation outcome for an opt-in `result.json` against its node schema. */
export interface ResultValidation {
  ok: boolean;
  problems?: string[];
}

/**
 * Validate a `result.json` against the node's (already dag-validated) result
 * schema subset.  Top-level types only — see `V3ResultSchema`.  Undeclared
 * extra properties are allowed (JSON-Schema default).
 */
export function validateResult(filePath: string, schema: V3ResultSchema): ResultValidation {
  if (!existsSync(filePath)) return { ok: false, problems: [`result.json not found at ${filePath}`] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (err) {
    return { ok: false, problems: [`result.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, problems: ['result.json root must be a JSON object'] };
  }
  const obj = parsed as Record<string, unknown>;
  const problems: string[] = [];
  for (const field of schema.required ?? []) {
    if (!(field in obj)) problems.push(`missing required field "${field}"`);
  }
  for (const [name, spec] of Object.entries(schema.properties)) {
    if (!(name in obj)) continue; // absence is only a problem when required
    const v = obj[name];
    const okType =
      spec.type === 'string' ? typeof v === 'string'
      : spec.type === 'number' ? typeof v === 'number' && Number.isFinite(v)
      : spec.type === 'boolean' ? typeof v === 'boolean'
      : spec.type === 'array' ? Array.isArray(v)
      : typeof v === 'object' && v !== null && !Array.isArray(v);
    if (!okType) problems.push(`field "${name}" must be of type ${spec.type}`);
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true };
}

// ─── Attempt numbering (journal-derived — no hardcoded 001) ──────────────────

const ATTEMPT_NNN_RE = /\/attempts\/(\d{3})$/;

function attemptNumber(attemptId: string): number | undefined {
  const m = ATTEMPT_NNN_RE.exec(attemptId);
  return m ? parseInt(m[1]!, 10) : undefined;
}

/**
 * Compute the attemptId the NEXT dispatch of `nodeId` must use, from the
 * journal: an unconsumed `nodeRetryRequested` reservation wins (retry intent
 * is authoritative for the redrive); otherwise max(seen)+1 — which is 001 for
 * a first dispatch.  Dispatch events are the authority for "seen"; a
 * reservation is consumed by a later `nodeDispatched` with the same number.
 */
export function nextAttemptIdFor(events: StoredEvent[], nodeId: string): string {
  let maxSeen = 0;
  let reserved: number | undefined;
  for (const e of events) {
    if (e.type === 'nodeDispatched' && e.nodeId === nodeId) {
      const n = attemptNumber(e.attemptId);
      if (n === undefined) continue;
      maxSeen = Math.max(maxSeen, n);
      if (reserved === n) reserved = undefined; // reservation consumed
    } else if (e.type === 'nodeRetryRequested' && e.nodeId === nodeId) {
      const n = attemptNumber(e.nextAttemptId);
      if (n === undefined) continue;
      reserved = n;
      maxSeen = Math.max(maxSeen, n);
    }
  }
  const n = reserved ?? maxSeen + 1;
  return `${nodeId}/attempts/${String(n).padStart(3, '0')}`;
}

/** Latest dispatched attemptId for a node (the `previousAttemptId` a retry
 *  entrypoint must reference).  Undefined when the node never dispatched. */
export function latestAttemptIdFor(events: StoredEvent[], nodeId: string): string | undefined {
  let latest: string | undefined;
  for (const e of events) {
    if (e.type === 'nodeDispatched' && e.nodeId === nodeId) latest = e.attemptId;
  }
  return latest;
}

// ─── Injected dependencies + options ────────────────────────────────────────

export interface V3RuntimeDeps {
  /** Spawn an ephemeral worker for one goal node (codex's pool). */
  runNode: RunNode;
  /** Validate a node's manifest after the worker exits (codex's manifest.ts). */
  validateManifest: ValidateManifest;
  /** Freeze a node's bot spawn config at run start.  Given `node.bot` (may be
   *  undefined → the run's default bot), returns the snapshot persisted in the
   *  runDir and threaded through `runNode` (never re-resolved mid-run). */
  resolveBotSnapshot: (botId: string | undefined) => BotSnapshot;
  /** Resolve a humanGate.  Required only if the DAG declares any gate; the
   *  runtime throws if a gate is hit without a handler.  (Wired by
   *  `human-gate.ts` post-milestone.) */
  resolveGate?: (req: {
    nodeId: string;
    prompt: string;
    waitId: string;
    runDir: string;
  }) => Promise<'approved' | 'rejected'>;
}

export interface V3RuntimeOptions {
  /** The run lives in `${baseDir}/${dag.runId}`. */
  baseDir: string;
  /** Gate handling model. `blocking` keeps the CLI/dev y/N path; `suspend`
   *  writes the pending wait and returns `awaitingGate` for a daemon/card layer
   *  to resolve and re-drive from disk. */
  gateMode?: 'blocking' | 'suspend'; // default blocking
  /** Concurrency caps (codex's three-layer cap; conservative defaults). */
  globalConcurrency?: number; // default 4
  perBotConcurrency?: number; // default 1
  perCliConcurrency?: number; // default 2
  cancelSignal?: AbortSignal;
}

export interface V3PendingGate {
  nodeId: string;
  waitId: string;
  prompt: string;
}

export type V3RunOutcome =
  | {
      reason: 'terminal';
      // `blocked` is its OWN status — never collapse it into failed (it is the
      // retryable half of the blocked/failed split).
      runStatus: 'succeeded' | 'failed' | 'blocked';
      failedNodeId?: string;
      blockedNodeId?: string;
      runDir: string;
    }
  | { reason: 'awaitingGate'; pendingWaits: V3PendingGate[]; runDir: string };

// ─── Main loop ───────────────────────────────────────────────────────────

/**
 * Run a validated DAG to terminal.  Resumable: if `journal.ndjson` already has
 * events (daemon restart), the loop picks up from the materialized state
 * instead of re-running completed nodes.
 */
export async function runWorkflow(
  dag: V3Dag,
  deps: V3RuntimeDeps,
  opts: V3RuntimeOptions,
): Promise<V3RunOutcome> {
  const runDir = join(opts.baseDir, dag.runId);
  mkdirSync(runDir, { recursive: true });
  const journalPath = join(runDir, 'journal.ndjson');
  const statePath = join(runDir, 'STATE');

  const globalCap = opts.globalConcurrency ?? 4;
  const perBotCap = opts.perBotConcurrency ?? 1;
  const perCliCap = opts.perCliConcurrency ?? 2;
  const gateMode = opts.gateMode ?? 'blocking';

  const nodesById = new Map(dag.nodes.map((n) => [n.id, n]));

  // Freeze bot snapshots once, keyed by the node's `bot` field (''=default),
  // and persist for audit / resume.  Re-resolving mid-run would let a drifted
  // bots.json change cliId/model/workingDir under a retry (codex point 1).
  const botSnapshots = new Map<string, BotSnapshot>();
  for (const node of dag.nodes) {
    const key = node.bot ?? '';
    if (!botSnapshots.has(key)) botSnapshots.set(key, deps.resolveBotSnapshot(node.bot));
  }

  // CLI-scope guard (老滕 directive): goal-mode rides the native `/goal`
  // command, which only Claude Code / Codex support.  Fail the whole run up
  // front — clearly — rather than spawning a worker on an unsupported CLI that
  // would never understand `/goal`.
  for (const [key, snap] of botSnapshots) {
    if (!isV3SupportedCli(snap.cliId)) {
      throw new Error(
        `v3 runtime: bot "${key || '<default>'}" resolves to CLI "${snap.cliId}", ` +
        `which is not supported by v3 goal-mode (supported: ${V3_SUPPORTED_CLIS.join(', ')})`,
      );
    }
  }

  writeFileSync(
    join(runDir, 'bots.snapshot.json'),
    JSON.stringify(Object.fromEntries(botSnapshots), null, 2),
  );

  // Persist the dag into the runDir so the dashboard projection can read the
  // node graph (depends → edges) and a resume is self-describing.  Deterministic
  // (same runId ⇒ same dag), so re-writing on resume is harmless.
  writeFileSync(join(runDir, 'dag.json'), JSON.stringify(dag, null, 2));

  // First run only: stamp runStarted (idempotent on resume).
  if (readJournal(journalPath).length === 0) {
    appendEvent(journalPath, { type: 'runStarted', runId: dag.runId });
  }

  // In-flight bookkeeping.  Work uses the nodeId as the key; gates use
  // `${nodeId}::gate` so a gated node's work + gate never collide.
  const inFlight = new Map<string, Promise<void>>();
  const botInFlight = new Map<string, number>();
  const cliInFlight = new Map<string, number>();

  while (true) {
    const events = readJournal(journalPath);
    const snap = materialize(events);
    writeState(statePath, snap);
    if (snap.runStatus !== 'running') break;

    const actions = decideNext(dag, snap.nodes);

    // Terminal sweep: write the run terminal event, then re-tick so the top of
    // the loop observes it and breaks (single exit path).
    const terminal = actions.find(
      (a) =>
        a.kind === 'completeRunSucceeded' ||
        a.kind === 'completeRunFailed' ||
        a.kind === 'completeRunBlocked',
    );
    if (terminal) {
      if (terminal.kind === 'completeRunSucceeded') {
        appendEvent(journalPath, { type: 'runSucceeded' });
      } else if (terminal.kind === 'completeRunFailed') {
        appendEvent(journalPath, { type: 'runFailed', failedNodeId: terminal.failedNodeId });
      } else {
        appendEvent(journalPath, { type: 'runBlocked', blockedNodeId: terminal.blockedNodeId });
      }
      continue;
    }

    // Dispatch the ready set under the three-layer cap.  Anything not started
    // this tick (cap hit) is retried next tick.
    let startedThisTick = 0;
    const aborted = opts.cancelSignal?.aborted === true;
    if (!aborted) {
      for (const a of actions) {
        if (inFlight.size >= globalCap) break;
        if (a.kind === 'dispatchWork') {
          const node = nodesById.get(a.nodeId)!;
          const botKey = node.bot ?? '';
          const botSnap = botSnapshots.get(botKey)!;
          if ((botInFlight.get(botKey) ?? 0) >= perBotCap) continue;
          if ((cliInFlight.get(botSnap.cliId) ?? 0) >= perCliCap) continue;
          startWork(node, botSnap, botKey, events);
          startedThisTick++;
        } else if (a.kind === 'dispatchGate') {
          startGate(nodesById.get(a.nodeId)!);
          startedThisTick++;
        }
      }
    }

    if (inFlight.size === 0) {
      if (aborted) break; // cancelled with nothing running → stop
      if (startedThisTick === 0) {
        const pendingWaits = gateMode === 'suspend' ? pendingGateWaits(snap.nodes) : [];
        if (pendingWaits.length > 0) {
          return { reason: 'awaitingGate', pendingWaits, runDir };
        }
        // Not terminal, nothing running, nothing dispatchable — a correct
        // decideNext never gets here; guard against an infinite spin.
        throw new Error('v3 runtime: no progress possible and run is not terminal');
      }
    }

    // Wait for at least one in-flight unit to settle before re-evaluating.
    if (inFlight.size > 0) await Promise.race(inFlight.values());
  }

  const finalSnap = materialize(readJournal(journalPath));
  return {
    reason: 'terminal',
    // Map 1:1 — blocked must NOT collapse into failed.  A 'running' snapshot
    // here means the loop exited via cancel-abort with nothing in flight;
    // report that as failed (the run did not complete).
    runStatus:
      finalSnap.runStatus === 'succeeded' ? 'succeeded'
      : finalSnap.runStatus === 'blocked' ? 'blocked'
      : 'failed',
    failedNodeId: finalSnap.failedNodeId,
    blockedNodeId: finalSnap.blockedNodeId,
    runDir,
  };

  // ─── closures over runDir / journalPath / caps ──────────────────────────

  function startWork(
    node: V3Node,
    botSnap: BotSnapshot,
    botKey: string,
    events: StoredEvent[],
  ): void {
    // Attempt number derived from the journal: 001 on first dispatch, the
    // reserved nextAttemptId after a blocked retry (no hardcoded 001 — a retry
    // must not overwrite the previous attempt's logs/manifest/pty).
    const attemptId = nextAttemptIdFor(events, node.id);
    const attemptNNN = attemptId.slice(attemptId.lastIndexOf('/') + 1);
    const attemptDir = join(runDir, node.id, 'attempts', attemptNNN);
    const outputDir = join(attemptDir, 'work');
    mkdirSync(outputDir, { recursive: true });

    const goalPath = join(attemptDir, 'goal.txt');
    writeFileSync(goalPath, renderGoalFile(node.goal ?? '', node.resultSchema));

    const inputsPath = join(attemptDir, 'inputs.json');
    writeFileSync(inputsPath, JSON.stringify(buildInputs(node, events), null, 2));

    const manifestPath = join(attemptDir, 'manifest.json');
    const env: Record<string, string> = {
      [GOAL_ENV.GOAL_PATH]: goalPath,
      [GOAL_ENV.INPUTS_PATH]: inputsPath,
      [GOAL_ENV.OUTPUT_DIR]: outputDir,
      [GOAL_ENV.MANIFEST_PATH]: manifestPath,
      [GOAL_ENV.ATTEMPT_DIR]: attemptDir,
      [GOAL_ENV.V3_MARKER]: '1',
    };

    appendEvent(journalPath, { type: 'nodeDispatched', nodeId: node.id, attemptId });
    botInFlight.set(botKey, (botInFlight.get(botKey) ?? 0) + 1);
    cliInFlight.set(botSnap.cliId, (cliInFlight.get(botSnap.cliId) ?? 0) + 1);

    // `isGoalNode` is guaranteed by validateDag (host is rejected), but the
    // contract types `runNode` to V3GoalNode, so narrow explicitly.
    if (!isGoalNode(node)) {
      appendEvent(journalPath, {
        type: 'nodeFailed', nodeId: node.id, attemptId,
        errorClass: 'workerError', message: `node "${node.id}" is not a goal node`,
      });
      releaseSlots(botKey, botSnap.cliId);
      return;
    }

    const req: RunNodeRequest = {
      runId: dag.runId,
      attemptId,
      node,
      botSnapshot: botSnap,
      runDir,
      attemptDir,
      inputsPath,
      outputDir,
      env,
      timeoutMs: (node.timeoutSec ?? DEFAULT_NODE_TIMEOUT_SEC) * 1000,
      cancelSignal: opts.cancelSignal,
      // Worker terminal is ready mid-run → stamp nodeSessionReady so the
      // dashboard can attach to the LIVE terminal.  Sync appendEvent (no await
      // on the pool's fire-and-forget ready path — codex note).
      onSessionReady: (info) => {
        // Drop the write `token` — never persist it (codex security review):
        // the dashboard view is read-only and doesn't need write access.
        appendEvent(journalPath, {
          type: 'nodeSessionReady',
          nodeId: node.id,
          attemptId,
          sessionInfo: { sessionId: info.sessionId, webPort: info.webPort },
          ptyLogPath: info.ptyLogPath,
        });
      },
    };

    const p = deps
      .runNode(req)
      .then(async (result) => {
        // Final verdict = process outcome AND manifest validation (codex
        // point 4 — NOT v0.2 final_output semantics).  Always validate the
        // manifest so a clean `status:'fail'` manifest yields a precise
        // root cause instead of an opaque process error (codex's advice).
        const verdict = await deps.validateManifest(result.manifestPath, outputDir);
        const manifestSaysOk = verdict.ok && verdict.manifest?.status === 'ok';

        if (result.status === 'ok' && manifestSaysOk) {
          // Opt-in structured-result contract: the manifest MUST list a
          // `result.json` entry (so it went through the manifest validator's
          // path/hash checks like every other product), and the file must
          // match the node's schema.  A violation BLOCKS (retryable), it does
          // not fail.
          if (node.resultSchema) {
            const entry = verdict.manifest!.files.find((f) => f.path === 'result.json');
            if (!entry) {
              appendEvent(journalPath, {
                type: 'nodeBlocked', nodeId: node.id, attemptId,
                errorClass: 'resultInvalid',
                message: 'node declares resultSchema but its manifest lists no "result.json" file',
              });
              return;
            }
            const res = validateResult(join(outputDir, entry.path), node.resultSchema);
            if (!res.ok) {
              appendEvent(journalPath, {
                type: 'nodeBlocked', nodeId: node.id, attemptId,
                errorClass: 'resultInvalid',
                message: (res.problems ?? ['result.json failed schema validation']).join('; '),
              });
              return;
            }
          }
          appendEvent(journalPath, {
            type: 'nodeSucceeded', nodeId: node.id, attemptId, manifestPath: result.manifestPath,
          });
          return;
        }

        let errorClass: V3ErrorClass;
        let message: string;
        let errorCode: string | undefined;
        let selfReportedFail = false;
        let retryable: boolean | undefined;
        if (!verdict.ok) {
          // Manifest missing / malformed.  If the process itself also failed,
          // the worker crash is the root cause; otherwise it's a bad manifest.
          errorClass = result.status === 'ok' ? 'manifestInvalid' : 'workerError';
          message = (verdict.problems ?? ['manifest missing or invalid']).join('; ');
        } else {
          // Manifest is structurally valid but declares failure (or the
          // process failed despite an ok manifest) — surface the node's own
          // error when present.  A self-reported fail is the agent's "I am
          // blocked, a human can fix this" channel (e.g. AUTH_REQUIRED with
          // retryable:true), so it feeds the blocked/failed split below.
          const m = verdict.manifest!;
          errorClass = 'workerError';
          if (m.status === 'fail' && m.error) {
            message = `${m.error.code}: ${m.error.message}`;
            errorCode = m.error.code;
            if (result.status === 'ok') {
              // Only an intact worker's self-report counts; a crashed process
              // with a leftover fail manifest is still an infrastructure error.
              selfReportedFail = true;
              retryable = m.error.retryable;
            }
          } else {
            message = 'runNode reported process failure';
          }
        }
        const kind = classifyTerminal(errorClass, { selfReportedFail, retryable });
        appendEvent(journalPath, {
          type: kind === 'blocked' ? 'nodeBlocked' : 'nodeFailed',
          nodeId: node.id, attemptId, errorClass, errorCode, message,
        });
      })
      .catch((err: unknown) => {
        appendEvent(journalPath, {
          type: 'nodeFailed', nodeId: node.id, attemptId,
          errorClass: 'workerError', message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        inFlight.delete(node.id);
        releaseSlots(botKey, botSnap.cliId);
      });
    inFlight.set(node.id, p);
  }

  function startGate(node: V3Node): void {
    const waitId = `${node.id}-gate`; // MVP: one gate per node
    const prompt = node.humanGate!.prompt;
    appendEvent(journalPath, { type: 'gateDispatched', nodeId: node.id, waitId });

    if (gateMode === 'suspend') {
      writePendingWait(runDir, { waitId, nodeId: node.id, prompt });
      return;
    }

    if (!deps.resolveGate) {
      throw new Error(
        `v3 runtime: node "${node.id}" has a humanGate but no resolveGate handler was injected`,
      );
    }
    const key = `${node.id}::gate`;
    const p = deps
      .resolveGate({ nodeId: node.id, prompt, waitId, runDir })
      .then((resolution) => {
        appendEvent(journalPath, { type: 'gateResolved', nodeId: node.id, waitId, resolution, by: 'human' });
      })
      .catch(() => {
        // A gate that errors out is treated as rejected (fail-fast); the
        // run-failure root cause is the rejection, recorded on the journal.
        appendEvent(journalPath, { type: 'gateResolved', nodeId: node.id, waitId, resolution: 'rejected', by: 'system' });
      })
      .finally(() => {
        inFlight.delete(key);
      });
    inFlight.set(key, p);
  }

  function pendingGateWaits(state: Map<string, { status: string }>): V3PendingGate[] {
    const waits: V3PendingGate[] = [];
    for (const node of dag.nodes) {
      if (state.get(node.id)?.status !== 'gateWaiting') continue;
      const prompt = node.humanGate?.prompt;
      if (!prompt) continue;
      waits.push({ nodeId: node.id, waitId: `${node.id}-gate`, prompt });
    }
    return waits;
  }

  function releaseSlots(botKey: string, cliId: string): void {
    botInFlight.set(botKey, Math.max(0, (botInFlight.get(botKey) ?? 1) - 1));
    cliInFlight.set(cliId, Math.max(0, (cliInFlight.get(cliId) ?? 1) - 1));
  }

  /** Resolve a node's upstream products into its `GoalInputs` (absolute paths).
   *  Reads each upstream's already-validated manifest from the latest
   *  `nodeSucceeded` event; the manifest's relative `path` is joined onto the
   *  upstream outputDir (`<manifestDir>/work`) to produce an absolute path the
   *  downstream agent can Read directly. */
  function buildInputs(node: V3Node, events: StoredEvent[]): GoalInputs {
    const inputs: GoalInputs['inputs'] = [];
    for (const ref of node.inputs) {
      const succ = [...events]
        .reverse()
        .find((e): e is StoredEvent & { type: 'nodeSucceeded' } =>
          e.type === 'nodeSucceeded' && e.nodeId === ref.from);
      if (!succ) continue; // deps are gated upstream — defensive skip
      const upstreamOutputDir = join(dirname(succ.manifestPath), 'work');
      const manifest = JSON.parse(readFileSync(succ.manifestPath, 'utf-8')) as Manifest;
      for (const f of manifest.files) {
        inputs.push({
          from: ref.from,
          name: f.name,
          path: join(upstreamOutputDir, f.path),
          kind: f.kind,
          preview: f.preview,
        });
      }
    }
    return { inputs };
  }
}
