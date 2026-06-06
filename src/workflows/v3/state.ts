/**
 * v3 state — materialize the journal into a run snapshot + STATE checkpoint.
 *
 * Two-layer truth (codex v1-review blocker #1):
 *   - `journal.ndjson` (journal.ts) = append-only audit truth
 *   - `STATE` (this file) = materialized checkpoint, derived by replaying the
 *     journal.  Cheap to grep, fast for the dashboard / a human to read, and
 *     re-derivable at any time so it never becomes an independent source of
 *     truth that can drift from the journal.
 *
 * Resume after a daemon restart replays the journal through `materialize`
 * (correctness first); the on-disk STATE file is an observability artifact and
 * a fast-path the runtime refreshes after every event.
 */

import { writeFileSync, renameSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoredEvent } from './journal.js';
import type { V3NodeState, V3NodeStatus, V3RunState } from './orchestrator.js';

export type V3RunStatus = 'running' | 'succeeded' | 'failed' | 'blocked';

export interface V3RunSnapshot {
  runStatus: V3RunStatus;
  /** Set once `runFailed` is observed — the node that triggered fail-fast. */
  failedNodeId?: string;
  /** Set once `runBlocked` is observed — the blocked node (cleared back to
   *  running by a subsequent `nodeRetryRequested` on replay). */
  blockedNodeId?: string;
  /** nodeId → current node state (the input `decideNext` consumes). */
  nodes: V3RunState;
  /** nodeId → the attemptId of its latest dispatch — or, after a
   *  `nodeRetryRequested`, the reserved `nextAttemptId` the retry will use. */
  attempts: Map<string, string>;
}

// ─── Materialize (replay) ────────────────────────────────────────────────

/**
 * Fold the journal into a snapshot.  Pure — same events always yield the same
 * snapshot, which is what makes STATE safe to throw away and re-derive.
 *
 * Node status transitions:
 *   nodeDispatched     → running   (preserve gateCleared across the transition)
 *   nodeSucceeded      → done
 *   nodeFailed         → failed
 *   nodeBlocked        → blocked
 *   nodeRetryRequested → pending  (+ attempt reservation; run blocked→running)
 *   gateDispatched     → gateWaiting
 *   gateResolved/ok    → pending + gateCleared (next tick dispatches work)
 *   gateResolved/no    → failed
 */
export function materialize(events: StoredEvent[]): V3RunSnapshot {
  const nodes: V3RunState = new Map();
  const attempts = new Map<string, string>();
  let runStatus: V3RunStatus = 'running';
  let failedNodeId: string | undefined;
  let blockedNodeId: string | undefined;

  const set = (id: string, status: V3NodeStatus, gateCleared?: boolean): void => {
    const prev = nodes.get(id);
    const next: V3NodeState = { status };
    // Carry an approved-gate flag forward unless this transition sets it.
    const carried = gateCleared ?? prev?.gateCleared;
    if (carried) next.gateCleared = true;
    nodes.set(id, next);
  };

  for (const e of events) {
    switch (e.type) {
      case 'runStarted':
        runStatus = 'running';
        break;
      case 'nodeDispatched':
        set(e.nodeId, 'running');
        attempts.set(e.nodeId, e.attemptId);
        break;
      case 'nodeSucceeded':
        set(e.nodeId, 'done');
        break;
      case 'nodeFailed':
        set(e.nodeId, 'failed');
        break;
      case 'nodeBlocked':
        set(e.nodeId, 'blocked');
        break;
      case 'nodeRetryRequested':
        // Replay-correct unblock (codex blocker #1 of the blocked design):
        // the retry is a journal event, so a fresh materialize() yields
        // pending — NOT a memory-only patch that evaporates on next replay.
        set(e.nodeId, 'pending');
        attempts.set(e.nodeId, e.nextAttemptId);
        if (runStatus === 'blocked') {
          runStatus = 'running';
          blockedNodeId = undefined;
        }
        break;
      case 'gateDispatched':
        set(e.nodeId, 'gateWaiting');
        break;
      case 'gateResolved':
        if (e.resolution === 'approved') set(e.nodeId, 'pending', true);
        else set(e.nodeId, 'failed');
        break;
      case 'runSucceeded':
        runStatus = 'succeeded';
        break;
      case 'runFailed':
        runStatus = 'failed';
        failedNodeId = e.failedNodeId;
        break;
      case 'runBlocked':
        runStatus = 'blocked';
        blockedNodeId = e.blockedNodeId;
        break;
    }
  }

  return { runStatus, failedNodeId, blockedNodeId, nodes, attempts };
}

// ─── STATE checkpoint (atomic write / read) ────────────────────────────────

/** On-disk shape of the STATE file — Maps flattened to plain objects so it's
 *  human-readable and `jq`-able. */
interface StateFile {
  runStatus: V3RunStatus;
  failedNodeId?: string;
  blockedNodeId?: string;
  nodes: Record<string, V3NodeState>;
  attempts: Record<string, string>;
  updatedAt: number;
}

/**
 * Write the snapshot to `statePath` atomically: write a sibling `.tmp` then
 * `rename` over the target (rename is atomic on the same filesystem), so a
 * crash mid-write never leaves a half-written STATE — readers see either the
 * old or the new file, never a torn one.
 */
export function writeState(statePath: string, snap: V3RunSnapshot): void {
  const dir = dirname(statePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file: StateFile = {
    runStatus: snap.runStatus,
    failedNodeId: snap.failedNodeId,
    blockedNodeId: snap.blockedNodeId,
    nodes: Object.fromEntries(snap.nodes),
    attempts: Object.fromEntries(snap.attempts),
    updatedAt: Date.now(),
  };
  const tmp = `${statePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2));
  renameSync(tmp, statePath);
}

/** Read a previously-written STATE checkpoint back into a snapshot.  Returns
 *  `undefined` when absent.  Resume normally prefers `materialize(readJournal)`
 *  (the journal is authoritative); this is for fast reads / observability. */
export function readState(statePath: string): V3RunSnapshot | undefined {
  if (!existsSync(statePath)) return undefined;
  const file = JSON.parse(readFileSync(statePath, 'utf-8')) as StateFile;
  return {
    runStatus: file.runStatus,
    failedNodeId: file.failedNodeId,
    blockedNodeId: file.blockedNodeId,
    nodes: new Map(Object.entries(file.nodes)),
    attempts: new Map(Object.entries(file.attempts)),
  };
}
