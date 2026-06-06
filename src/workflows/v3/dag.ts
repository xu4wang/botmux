/**
 * v3 DAG definition — schema, loader, validator, topological order.
 *
 * The v3 runtime (LLM-driven workflow) loads a hand-written `dag.json`,
 * validates it, and walks it in topological order with deps gating.  This
 * module is the *schema half* of the engine: pure data + validation, no IO
 * side effects beyond reading the file in `loadDag`.
 *
 * Deliberately standalone from v0.2's `definition.ts` — v3 nodes are a much
 * smaller surface (goal / host, no loop / decision / fanout) and coupling the
 * two schemas would drag v0.2's complexity into the new engine.  See
 * `docs/design/2026-06-01-v3-mvp-engine-split.md` §3 for the authored shape.
 */

import { readFileSync } from 'node:fs';

// ─── Schema ──────────────────────────────────────────────────────────────

/**
 * `goal` — an LLM node driven by the `botmux-goal` skill (single goal, one
 *   ephemeral worker).  `host` — a deterministic side-effect node (feishu-send
 *   / base write / schedule) that does NOT route through an LLM.  MVP runs
 *   `goal` nodes end to end; `host` is reserved in the schema so the runtime
 *   can grow into it without a breaking change (it is rejected at validate
 *   time until the executor lands — see `validateDag`).
 */
export type V3NodeType = 'goal' | 'host';

export const NODE_KINDS: readonly V3NodeType[] = ['goal', 'host'];

/** Default per-node wall-clock budget when a node omits `timeoutSec`.
 *  Generous on purpose: completion is detected by the manifest watcher
 *  (seconds after the agent finishes), so the timeout only fires for hung
 *  nodes — a long default costs nothing on the happy path.  The architect is
 *  prompted to set per-node `timeoutSec` explicitly for long tasks. */
export const DEFAULT_NODE_TIMEOUT_SEC = 1800;

/** Hard ceiling for per-node `timeoutSec` (4h) — rejects runaway budgets the
 *  architect might hallucinate while still allowing genuinely long tasks. */
export const MAX_NODE_TIMEOUT_SEC = 14400;

/** A humanGate frozen at authoring time — the runtime never lets a node
 *  add / skip a gate at runtime (design Q10). */
export interface V3HumanGate {
  /** Approval-card body shown to the human reviewer. */
  prompt: string;
}

/**
 * Declares that this node consumes an upstream node's products.  MVP pulls the
 * upstream node's *whole* manifest (all files) into this node's `inputs.json`;
 * a per-file selector is deferred (design §2.3).  Invariant: `from` MUST also
 * appear in the node's `depends` — you can only read outputs of a node you
 * wait for.
 */
export interface V3InputRef {
  /** Upstream nodeId whose manifest files become this node's inputs. */
  from: string;
}

/**
 * Opt-in structured-output contract — a deliberately TINY subset of
 * JSON-Schema (flat object, primitive-typed properties, optional required
 * list).  Hand-validated (no deps, repo style); anything outside the subset
 * is rejected at validateDag time so the architect can never author a schema
 * the runtime's validator cannot execute.
 *
 * NOT supported (first slice): nested schemas, array item types, enums,
 * patterns.  `type:'array'|'object'` properties validate the TOP-LEVEL type
 * only.
 */
export interface V3ResultSchema {
  type: 'object';
  properties: Record<string, { type: V3ResultFieldType }>;
  required?: string[];
}

export type V3ResultFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object';

const RESULT_FIELD_TYPES: readonly V3ResultFieldType[] = ['string', 'number', 'boolean', 'array', 'object'];

/** Caps on the resultSchema subset (anti-runaway: a giant schema bloats the
 *  goal prompt and the validator).  Checked at validateDag time. */
export const RESULT_SCHEMA_MAX_PROPERTIES = 32;
export const RESULT_SCHEMA_MAX_BYTES = 4096;

export interface V3Node {
  /** Unique within the DAG; also used as a runDir path segment, so it is
   *  constrained to `[A-Za-z0-9._-]`. */
  id: string;
  type: V3NodeType;
  /** Required + non-empty for `goal` nodes; the single-sentence objective. */
  goal?: string;
  /** Which bot/CLI runs this node.  MVP dogfoods a single CLI, but the field
   *  is per-node so a mixed-backend DAG is a non-breaking extension. */
  bot?: string;
  /** Upstream node ids that must reach `done` before this node dispatches. */
  depends: string[];
  /** Upstream products to thread in as inputs (every `from` ⊆ `depends`). */
  inputs: V3InputRef[];
  /** Wall-clock budget in seconds; falls back to DEFAULT_NODE_TIMEOUT_SEC. */
  timeoutSec?: number;
  /** Optional human approval gate, evaluated *before* the node's work runs. */
  humanGate?: V3HumanGate | null;
  /** Opt-in structured-output contract: when set, the node must write a
   *  `result.json` (listed in its manifest files) matching this schema; a
   *  violation blocks (not fails) the node.  Absent → zero behavior change. */
  resultSchema?: V3ResultSchema;
}

/** A `V3Node` narrowed to a goal node — `goal` is guaranteed present.  This is
 *  what crosses into `runNode` (the pool only ever runs goal nodes in MVP). */
export interface V3GoalNode extends V3Node {
  type: 'goal';
  goal: string;
}

/** Narrowing guard: a validated goal node always has a non-empty `goal`. */
export function isGoalNode(node: V3Node): node is V3GoalNode {
  return node.type === 'goal' && typeof node.goal === 'string' && node.goal.length > 0;
}

export interface V3Dag {
  /** Stable id for this run; used as the runDir name, so path-segment safe. */
  runId: string;
  nodes: V3Node[];
}

// ─── Validation ─────────────────────────────────────────────────────────

/** Thrown by `validateDag` / `loadDag` with every problem found, not just the
 *  first — authoring a DAG by hand is iterative, so surface the full list. */
export class DagValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid v3 dag.json:\n  - ${problems.join('\n  - ')}`);
    this.name = 'DagValidationError';
  }
}

/** Node ids and runId double as filesystem path segments under the runDir. */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate an untrusted parsed value into a `V3Dag`.  Pure — throws
 * `DagValidationError` with the full problem list on any violation, otherwise
 * returns a normalized dag (defaults filled, `humanGate: undefined` → `null`).
 *
 * Checks: runId shape; non-empty unique path-safe node ids; known `type`;
 * `goal` non-empty for goal nodes; `host` rejected (executor not yet built);
 * `depends` reference existing nodes, no self-dep, no dups; `inputs.from`
 * reference existing nodes AND appear in `depends`; acyclic (delegated to
 * `topologicalOrder`).
 */
export function validateDag(raw: unknown): V3Dag {
  const problems: string[] = [];

  if (!isObject(raw)) {
    throw new DagValidationError(['root must be a JSON object']);
  }
  if (typeof raw.runId !== 'string' || !SEGMENT_RE.test(raw.runId)) {
    problems.push(`runId must be a path-safe string matching ${SEGMENT_RE} (got ${JSON.stringify(raw.runId)})`);
  }
  if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
    throw new DagValidationError([...problems, 'nodes must be a non-empty array']);
  }

  const ids = new Set<string>();
  const nodes: V3Node[] = [];

  for (let i = 0; i < raw.nodes.length; i++) {
    const n = raw.nodes[i];
    const where = `nodes[${i}]`;
    if (!isObject(n)) {
      problems.push(`${where} must be an object`);
      continue;
    }
    const id = n.id;
    if (typeof id !== 'string' || !SEGMENT_RE.test(id)) {
      problems.push(`${where}.id must be a path-safe string matching ${SEGMENT_RE} (got ${JSON.stringify(id)})`);
      continue;
    }
    if (ids.has(id)) {
      problems.push(`duplicate node id "${id}"`);
      continue;
    }
    ids.add(id);

    const type = n.type;
    if (type !== 'goal' && type !== 'host') {
      problems.push(`node "${id}".type must be one of ${NODE_KINDS.join(' | ')} (got ${JSON.stringify(type)})`);
      continue;
    }
    if (type === 'host') {
      problems.push(`node "${id}": type "host" is reserved but not yet executable in MVP — use "goal"`);
      continue;
    }
    if (typeof n.goal !== 'string' || n.goal.trim() === '') {
      problems.push(`goal node "${id}".goal must be a non-empty string`);
    }

    const depends = normStringArray(n.depends, `node "${id}".depends`, problems);
    if (depends.includes(id)) problems.push(`node "${id}" depends on itself`);
    if (new Set(depends).size !== depends.length) problems.push(`node "${id}".depends has duplicates`);

    const inputs = normInputs(n.inputs, id, problems);

    let timeoutSec: number | undefined;
    if (n.timeoutSec !== undefined) {
      if (typeof n.timeoutSec !== 'number' || !Number.isFinite(n.timeoutSec) || n.timeoutSec <= 0) {
        problems.push(`node "${id}".timeoutSec must be a positive number`);
      } else if (n.timeoutSec > MAX_NODE_TIMEOUT_SEC) {
        problems.push(`node "${id}".timeoutSec ${n.timeoutSec} exceeds the ${MAX_NODE_TIMEOUT_SEC}s (4h) ceiling`);
      } else {
        timeoutSec = n.timeoutSec;
      }
    }

    const resultSchema = normResultSchema(n.resultSchema, id, problems);

    let humanGate: V3HumanGate | null = null;
    if (n.humanGate != null) {
      if (!isObject(n.humanGate) || typeof n.humanGate.prompt !== 'string' || n.humanGate.prompt.trim() === '') {
        problems.push(`node "${id}".humanGate must be { prompt: <non-empty string> } or null`);
      } else {
        humanGate = { prompt: n.humanGate.prompt };
      }
    }

    nodes.push({
      id,
      type,
      goal: typeof n.goal === 'string' ? n.goal : undefined,
      bot: typeof n.bot === 'string' ? n.bot : undefined,
      depends,
      inputs,
      timeoutSec,
      humanGate,
      resultSchema,
    });
  }

  // Cross-node reference checks — only meaningful once ids are collected.
  for (const node of nodes) {
    for (const dep of node.depends) {
      if (!ids.has(dep)) problems.push(`node "${node.id}" depends on unknown node "${dep}"`);
    }
    for (const inp of node.inputs) {
      if (!ids.has(inp.from)) {
        problems.push(`node "${node.id}".inputs references unknown node "${inp.from}"`);
      } else if (!node.depends.includes(inp.from)) {
        problems.push(`node "${node.id}".inputs.from "${inp.from}" must also be in depends`);
      }
    }
  }

  if (problems.length > 0) throw new DagValidationError(problems);

  const dag: V3Dag = { runId: raw.runId as string, nodes };
  // Cycle detection: topologicalOrder throws on a cycle.  Run it here so
  // loadDag rejects a cyclic DAG up front rather than mid-run.
  topologicalOrder(dag);
  return dag;
}

function normStringArray(v: unknown, where: string, problems: string[]): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    problems.push(`${where} must be an array of strings`);
    return [];
  }
  return v as string[];
}

/**
 * Validate the opt-in `resultSchema` against the supported subset.  Strict on
 * purpose: unknown keywords are REJECTED (not ignored) so a schema the
 * validator silently wouldn't enforce can never enter a dag (codex v2 of the
 * blocked design).  Caps: ≤32 properties, ≤4KB serialized, flat (depth 1).
 */
function normResultSchema(v: unknown, id: string, problems: string[]): V3ResultSchema | undefined {
  if (v === undefined || v === null) return undefined;
  const where = `node "${id}".resultSchema`;
  if (!isObject(v)) {
    problems.push(`${where} must be an object`);
    return undefined;
  }
  const knownTop = new Set(['type', 'properties', 'required']);
  for (const key of Object.keys(v)) {
    if (!knownTop.has(key)) {
      problems.push(`${where} has unsupported keyword "${key}" (subset allows: type/properties/required)`);
      return undefined;
    }
  }
  if (v.type !== 'object') {
    problems.push(`${where}.type must be "object"`);
    return undefined;
  }
  if (!isObject(v.properties) || Object.keys(v.properties).length === 0) {
    problems.push(`${where}.properties must be a non-empty object`);
    return undefined;
  }
  const props = Object.entries(v.properties);
  if (props.length > RESULT_SCHEMA_MAX_PROPERTIES) {
    problems.push(`${where} has ${props.length} properties (max ${RESULT_SCHEMA_MAX_PROPERTIES})`);
    return undefined;
  }
  const properties: Record<string, { type: V3ResultFieldType }> = {};
  for (const [name, spec] of props) {
    if (!isObject(spec)) {
      problems.push(`${where}.properties.${name} must be an object`);
      return undefined;
    }
    for (const key of Object.keys(spec)) {
      if (key !== 'type') {
        problems.push(`${where}.properties.${name} has unsupported keyword "${key}" (subset allows: type)`);
        return undefined;
      }
    }
    if (!RESULT_FIELD_TYPES.includes(spec.type as V3ResultFieldType)) {
      problems.push(`${where}.properties.${name}.type must be one of ${RESULT_FIELD_TYPES.join(' | ')}`);
      return undefined;
    }
    properties[name] = { type: spec.type as V3ResultFieldType };
  }
  let required: string[] | undefined;
  if (v.required !== undefined) {
    if (!Array.isArray(v.required) || v.required.some((x) => typeof x !== 'string')) {
      problems.push(`${where}.required must be an array of strings`);
      return undefined;
    }
    const unknown = (v.required as string[]).filter((r) => !(r in properties));
    if (unknown.length > 0) {
      problems.push(`${where}.required references undeclared properties: ${unknown.join(', ')}`);
      return undefined;
    }
    if (new Set(v.required).size !== v.required.length) {
      problems.push(`${where}.required has duplicates`);
      return undefined;
    }
    required = v.required as string[];
  }
  const schema: V3ResultSchema = required ? { type: 'object', properties, required } : { type: 'object', properties };
  const bytes = Buffer.byteLength(JSON.stringify(schema), 'utf-8');
  if (bytes > RESULT_SCHEMA_MAX_BYTES) {
    problems.push(`${where} serializes to ${bytes} bytes (max ${RESULT_SCHEMA_MAX_BYTES})`);
    return undefined;
  }
  return schema;
}

function normInputs(v: unknown, id: string, problems: string[]): V3InputRef[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    problems.push(`node "${id}".inputs must be an array`);
    return [];
  }
  const out: V3InputRef[] = [];
  for (let j = 0; j < v.length; j++) {
    const inp = v[j];
    if (!isObject(inp) || typeof inp.from !== 'string') {
      problems.push(`node "${id}".inputs[${j}] must be { from: <nodeId> }`);
      continue;
    }
    out.push({ from: inp.from });
  }
  return out;
}

// ─── Loader ─────────────────────────────────────────────────────────────

/** Read + JSON.parse + validate a `dag.json` at `path`.  Throws
 *  `DagValidationError` on a malformed graph and a plain `Error` on read /
 *  parse failure (so callers can distinguish "bad file" from "bad graph"). */
export function loadDag(path: string): V3Dag {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    throw new Error(`v3: cannot read dag.json at ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`v3: dag.json at ${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return validateDag(parsed);
}

// ─── Topological order ─────────────────────────────────────────────────

/**
 * Deterministic topological order via Kahn's algorithm.  Ties (nodes with the
 * same remaining in-degree available at once) are broken by ascending id so
 * the schedule is stable across runs — important for reproducible journals.
 * Throws if the graph contains a cycle (lists the offending nodes).
 *
 * Assumes `depends` already reference existing nodes; `validateDag` enforces
 * that before calling here.
 */
export function topologicalOrder(dag: V3Dag): string[] {
  const indeg = new Map<string, number>();
  const adj = new Map<string, string[]>(); // dep → dependents
  for (const node of dag.nodes) {
    indeg.set(node.id, indeg.get(node.id) ?? 0);
    if (!adj.has(node.id)) adj.set(node.id, []);
  }
  for (const node of dag.nodes) {
    for (const dep of node.depends) {
      indeg.set(node.id, (indeg.get(node.id) ?? 0) + 1);
      adj.get(dep)!.push(node.id);
    }
  }

  // Ready set kept sorted for deterministic tie-breaking.
  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order: string[] = [];
  while (ready.length > 0) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = indeg.get(next)! - 1;
      indeg.set(next, d);
      if (d === 0) {
        // Insert keeping `ready` sorted.
        const pos = lowerBound(ready, next);
        ready.splice(pos, 0, next);
      }
    }
  }

  if (order.length !== dag.nodes.length) {
    const stuck = dag.nodes.map((n) => n.id).filter((id) => !order.includes(id));
    throw new DagValidationError([`dag has a cycle among nodes: ${stuck.join(', ')}`]);
  }
  return order;
}

/** Index of the first element in sorted `arr` not less than `x`. */
function lowerBound(arr: string[], x: string): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
