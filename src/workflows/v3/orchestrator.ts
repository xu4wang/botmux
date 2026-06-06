/**
 * v3 orchestrator — pure decision layer.
 *
 * Mirrors v0.2's `orchestrator.ts` pattern: a pure function maps the current
 * run state + DAG to a list of action descriptors.  The runtime (`runtime.ts`)
 * owns every side effect — journal/STATE writes, ephemeral-worker dispatch via
 * `runNode`, humanGate card posting — and the per-bot/per-CLI/global
 * concurrency caps.  Keeping the decision pure makes the critical-path
 * semantics testable without spawning workers or touching the filesystem.
 *
 * MVP scope: static DAG, fail-fast.  No loops / decisions / dynamic expand
 * (those are deferred — design Q3/§7).  Gate set is frozen at authoring time;
 * the orchestrator never invents or skips a gate (design Q10).
 */

import { topologicalOrder, type V3Dag } from './dag.js';

// ─── Run state (materialized from the journal by state.ts) ──────────────────

export type V3NodeStatus =
  | 'pending'      // not yet dispatched (deps may or may not be ready)
  | 'gateWaiting'  // humanGate dispatched, awaiting human resolution
  | 'running'      // worker dispatched, in flight
  | 'done'         // succeeded (work + manifest validated)
  | 'blocked'      // semantic/contract failure — recoverable via retry (new attempt)
  | 'failed';      // infrastructure failure / gate rejected / timed out — needs intervention

export interface V3NodeState {
  status: V3NodeStatus;
  /** True once an approved humanGate cleared this node — so after approval the
   *  next tick dispatches work instead of re-dispatching the gate.  A rejected
   *  gate transitions the node straight to `failed` (set by the runtime), so
   *  this flag only ever records the approved case. */
  gateCleared?: boolean;
}

/** nodeId → state.  A node absent from the map is treated as `pending`. */
export type V3RunState = Map<string, V3NodeState>;

// ─── Actions (runtime translates each into journal writes + side effects) ───

export type V3Action =
  /** Post the humanGate approval card + persist a `waits/<id>.json` (Q10). */
  | { kind: 'dispatchGate'; nodeId: string }
  /** Spawn an ephemeral worker via `runNode` for this node's goal. */
  | { kind: 'dispatchWork'; nodeId: string }
  /** Terminal: every node done; the run's product is the sink set. */
  | { kind: 'completeRunSucceeded' }
  /** Terminal (fail-fast): a node failed, so the run cannot proceed. */
  | { kind: 'completeRunFailed'; failedNodeId: string }
  /** Terminal-for-now: a node is blocked (contract failure, recoverable).
   *  Halts dispatch like failed, but the run can resume via a retry event. */
  | { kind: 'completeRunBlocked'; blockedNodeId: string };

// ─── Decision function ──────────────────────────────────────────────────────

/**
 * Pure decision: given the current `state`, return every action that can be
 * taken *now*.  The runtime applies concurrency caps by acting on a prefix of
 * the returned dispatch actions and re-invoking on the next tick — this
 * function intentionally returns ALL ready dispatches (it does not throttle).
 *
 * Ordering follows topological order so callers see deps-ready nodes first.
 * Fail-fast: the moment any node is `failed`, the only action is
 * `completeRunFailed` (in-flight peers are torn down by the runtime / cancel).
 * When no dispatch is possible and nothing is pending, the run is complete.
 */
export function decideNext(dag: V3Dag, state: V3RunState): V3Action[] {
  const order = topologicalOrder(dag);
  const nodes = new Map(dag.nodes.map((n) => [n.id, n]));

  // Fail-fast sweep first: a single failed node ends the run.  Pick the
  // earliest in topo order for a deterministic `failedNodeId`.  `failed`
  // (infrastructure, needs intervention) takes priority over `blocked`
  // (contract failure, retryable) when both exist.
  for (const id of order) {
    if (st(state, id).status === 'failed') {
      return [{ kind: 'completeRunFailed', failedNodeId: id }];
    }
  }
  for (const id of order) {
    if (st(state, id).status === 'blocked') {
      return [{ kind: 'completeRunBlocked', blockedNodeId: id }];
    }
  }

  const actions: V3Action[] = [];
  let pending = 0; // nodes not yet terminal — gates the success sweep

  for (const id of order) {
    const node = nodes.get(id)!;
    const s = st(state, id);

    if (s.status === 'done') continue;

    // In-flight: a dispatched worker or an open gate. Nothing to emit; the
    // node is still pending completion.
    if (s.status === 'running' || s.status === 'gateWaiting') {
      pending++;
      continue;
    }

    // s.status === 'pending'
    pending++;
    const depsOk = node.depends.every((dep) => st(state, dep).status === 'done');
    if (!depsOk) continue;

    if (node.humanGate && !s.gateCleared) {
      actions.push({ kind: 'dispatchGate', nodeId: id });
      continue;
    }
    actions.push({ kind: 'dispatchWork', nodeId: id });
  }

  if (actions.length === 0 && pending === 0) {
    return [{ kind: 'completeRunSucceeded' }];
  }
  return actions;
}

/** Sink nodes — no other node depends on them.  Their products are the run's
 *  output.  Pure helper for the runtime's success path. */
export function findSinks(dag: V3Dag): string[] {
  const referenced = new Set<string>();
  for (const node of dag.nodes) for (const dep of node.depends) referenced.add(dep);
  return dag.nodes.map((n) => n.id).filter((id) => !referenced.has(id));
}

function st(state: V3RunState, id: string): V3NodeState {
  return state.get(id) ?? { status: 'pending' };
}
