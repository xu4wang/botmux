/**
 * Host-neutral application service for v3 Saved Workflows.
 *
 * The schema/store/materializer modules own persistence and execution
 * contracts.  This layer adds the user-context rules shared by future CLI,
 * IM, and dashboard adapters: source-run ownership, chat/global visibility,
 * explicit name ambiguity, owner-only revision updates, and published-only
 * instantiation.  It has no daemon/session-store dependency; hosts pass the
 * already-authenticated actor + chat context in.
 */

import type { BotConfig } from '../../bot-registry.js';
import { existsSync, promises as fs, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { withFileLockSync } from '../../utils/file-lock.js';
import type { RawParamInput } from '../params.js';
import {
  compileSavedWorkflowFromRun,
  materializeSavedWorkflowRun,
  type CompileSavedWorkflowFromRunOptions,
  type MaterializedSavedWorkflowRun,
} from './library-materialize.js';
import {
  SAVED_WORKFLOW_ID_RE,
  normalizeSavedWorkflowLookupKey,
  validateSavedWorkflowRevisionPayload,
  type SavedWorkflowMetadata,
  type SavedWorkflowOwner,
  type SavedWorkflowScope,
} from './library-schema.js';
import {
  SavedWorkflowConflictError,
  SavedWorkflowNotFoundError,
  SavedWorkflowPermissionError,
  appendSavedWorkflowRevision,
  createSavedWorkflow,
  listSavedWorkflows,
  loadCurrentSavedWorkflow,
  readSavedWorkflowMetadata,
  type SavedWorkflowListResult,
  type SavedWorkflowWriteResult,
} from './library-store.js';
import {
  artifactRef,
  loadAuthorizedV3Run,
  makeLegacyV3RunEnvelope,
  publishRunEnvelopeOnce,
  readRunEnvelope,
  type LoadedAuthorizedV3Run,
} from './run-envelope.js';
import { isValidRunId } from './ops-projection.js';
import { readJournal } from './journal.js';
import { materialize } from './state.js';
import { readGrillState } from './grill-state.js';
import { loadDag } from './dag.js';
import { validateSpec } from './spec.js';
import { parseFrozenBotSnapshots } from './bot-resolve.js';

export interface SavedWorkflowActorContext {
  actor: SavedWorkflowOwner;
  /** Current invocation chat. Optional for a global-only list/resolve. */
  chatId?: string;
  rootMessageId?: string;
  sessionId?: string;
}

export type SavedWorkflowServiceErrorCode =
  | 'invalid_context'
  | 'source_not_owned'
  | 'scope_mismatch'
  | 'not_found'
  | 'ambiguous'
  | 'not_published';

export class SavedWorkflowServiceError extends Error {
  constructor(
    public readonly code: SavedWorkflowServiceErrorCode,
    message: string,
    public readonly matches: SavedWorkflowMetadata[] = [],
  ) {
    super(message);
    this.name = 'SavedWorkflowServiceError';
  }
}

interface SaveTerminalRunBase {
  dataDir: string;
  runDir: string;
  context: SavedWorkflowActorContext;
  /** Failed/blocked sources are draft-only and require this explicit opt-in. */
  allowDraft?: boolean;
  acknowledgeUnsafeLiterals?: boolean;
  now?: Date;
}

export interface SaveTerminalRunAsNewWorkflowInput extends SaveTerminalRunBase {
  workflowId?: never;
  displayName?: string;
  aliases?: string[];
  /** Defaults to the current chat. Global publication must be explicit. */
  scope?: 'chat' | 'global';
}

export interface AppendTerminalRunToWorkflowInput extends SaveTerminalRunBase {
  /** Supplying an id always means append; it never creates implicitly. */
  workflowId: string;
  expectedLatestRevision?: string;
  displayName?: never;
  aliases?: never;
  scope?: never;
}

export type SaveTerminalRunAsWorkflowInput =
  | SaveTerminalRunAsNewWorkflowInput
  | AppendTerminalRunToWorkflowInput;

export interface SaveTerminalRunAsWorkflowResult extends SavedWorkflowWriteResult {
  sourceStatus: 'succeeded' | 'failed' | 'blocked';
  created: boolean;
}

export interface ListVisibleSavedWorkflowsInput {
  dataDir: string;
  context: SavedWorkflowActorContext;
  includeArchived?: boolean;
  includeDrafts?: boolean;
}

export interface ResolveVisibleSavedWorkflowInput extends ListVisibleSavedWorkflowsInput {
  ref: string;
}

export interface InstantiatePublishedSavedWorkflowInput {
  dataDir: string;
  ref: string;
  context: SavedWorkflowActorContext;
  rawParams?: Record<string, RawParamInput>;
  bots: BotConfig[];
  baseDir: string;
  runId?: string;
  now?: Date;
}

export interface ResolveOwnedTerminalRunInput {
  baseDir: string;
  source: 'last' | string;
  context: SavedWorkflowActorContext;
}

type TerminalSourceStatus = 'succeeded' | 'failed' | 'blocked';

function terminalSourceStatus(runDir: string, runId: string): TerminalSourceStatus {
  const events = readJournal(join(runDir, 'journal.ndjson'));
  const starts = events.filter((event) => event.type === 'runStarted');
  if (starts.length !== 1 || starts[0]!.runId !== runId) {
    throw new SavedWorkflowServiceError(
      'invalid_context',
      `Run '${runId}' has no single matching runStarted identity`,
    );
  }
  const status = materialize(events).runStatus;
  if (status !== 'succeeded' && status !== 'failed' && status !== 'blocked') {
    throw new SavedWorkflowServiceError(
      'invalid_context',
      `Run '${runId}' is not terminal (status=${status})`,
    );
  }
  return status;
}

/**
 * Strictly load a terminal source and opportunistically seal the narrow class
 * of pre-run.json v3 runs whose ownership is still provable from their
 * Gate-2 grill binding. Historical runs without ownerOpenId remain rejected:
 * assigning them to whoever asks first in a shared chat would be an ownership
 * escalation, not a migration.
 */
function loadOwnedTerminalRunForSave(
  runDir: string,
  context: SavedWorkflowActorContext,
): { loaded: LoadedAuthorizedV3Run; status: TerminalSourceStatus } {
  const runId = basename(runDir);
  if (!isValidRunId(runId)) {
    throw new SavedWorkflowServiceError('invalid_context', `Invalid source runId ${JSON.stringify(runId)}`);
  }

  const sealIfNeeded = (): void => {
    const initial = readRunEnvelope(runDir, runId);
    if (initial.kind === 'ok') return;
    if (initial.kind === 'invalid') {
      throw new SavedWorkflowServiceError(
        'invalid_context',
        `Run '${runId}' has an invalid run.json: ${initial.problems.join('; ')}`,
      );
    }

    withFileLockSync(join(runDir, 'run.json'), () => {
      const current = readRunEnvelope(runDir, runId);
      if (current.kind === 'ok') return;
      if (current.kind === 'invalid') {
        throw new SavedWorkflowServiceError(
          'invalid_context',
          `Run '${runId}' has an invalid run.json: ${current.problems.join('; ')}`,
        );
      }

      const grill = readGrillState(runDir);
      const binding = grill?.chatBinding;
      if (
        !grill ||
        grill.runId !== runId ||
        grill.status !== 'dag_approved' ||
        !binding ||
        !binding.ownerOpenId
      ) {
        throw new SavedWorkflowServiceError(
          'invalid_context',
          `Run '${runId}' predates Saved Workflow sealing and its owner cannot be proven. ` +
          'Re-run it on the current version, or migrate it explicitly as an administrator.',
        );
      }
      if (
        binding.ownerOpenId !== context.actor.openId ||
        binding.larkAppId !== context.actor.larkAppId ||
        binding.chatId !== context.chatId
      ) {
        throw new SavedWorkflowServiceError('source_not_owned', `Source run '${runId}' belongs to a different actor`);
      }

      const dagPath = join(runDir, 'dag.json');
      const specPath = join(runDir, 'spec.json');
      const botPath = join(runDir, 'bots.snapshot.json');
      if (![dagPath, specPath, botPath].every(existsSync)) {
        throw new SavedWorkflowServiceError(
          'invalid_context',
          `Run '${runId}' is missing canonical dag/spec/bot artifacts and cannot be sealed for saving`,
        );
      }
      const dag = loadDag(dagPath);
      if (dag.runId !== runId) throw new Error(`legacy DAG runId mismatch: ${dag.runId}`);
      const spec = validateSpec(JSON.parse(readFileSync(specPath, 'utf-8')));
      if (spec.runId !== runId) throw new Error(`legacy spec runId mismatch: ${spec.runId}`);
      parseFrozenBotSnapshots(JSON.parse(readFileSync(botPath, 'utf-8')), dag);
      terminalSourceStatus(runDir, runId);

      publishRunEnvelopeOnce(runDir, makeLegacyV3RunEnvelope({
        runId,
        createdAt: grill.createdAt,
        backfilledAt: new Date().toISOString(),
        original: 'grill',
        basis: 'runtime_started',
        chatBinding: binding,
        artifacts: {
          dag: artifactRef(runDir, 'dag.json'),
          spec: artifactRef(runDir, 'spec.json'),
          botSnapshots: artifactRef(runDir, 'bots.snapshot.json'),
        },
      }));
    });
  };

  sealIfNeeded();
  const loaded = loadAuthorizedV3Run(runDir, {
    allowedSources: ['ad_hoc', 'saved_definition', 'legacy_v3'],
  });
  assertSourceOwnedByCaller(loaded, context);
  return { loaded, status: terminalSourceStatus(runDir, runId) };
}

/** Resolve `last` within the authenticated actor+chat scope, never globally. */
export async function resolveOwnedTerminalRunDir(
  input: ResolveOwnedTerminalRunInput,
): Promise<string> {
  const context = requireActorContext(input.context, { requireChat: true });
  if (input.source !== 'last') {
    if (!isValidRunId(input.source)) {
      throw new SavedWorkflowServiceError('invalid_context', `Invalid source runId ${JSON.stringify(input.source)}`);
    }
    const runDir = join(input.baseDir, input.source);
    try {
      const stat = await fs.stat(runDir);
      if (!stat.isDirectory()) throw notFound(input.source);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound(input.source);
      throw err;
    }
    loadOwnedTerminalRunForSave(runDir, context);
    return runDir;
  }

  let names: string[];
  try { names = await fs.readdir(input.baseDir); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('last run');
    throw err;
  }
  const candidates: Array<{ runDir: string; createdAt: string; runId: string }> = [];
  for (const runId of names) {
    if (!isValidRunId(runId)) continue;
    const runDir = join(input.baseDir, runId);
    try {
      const stat = await fs.stat(runDir);
      if (!stat.isDirectory()) continue;
      const candidate = loadOwnedTerminalRunForSave(runDir, context);
      candidates.push({ runDir, createdAt: candidate.loaded.envelope.createdAt, runId });
    } catch { /* malformed/incomplete candidate is not "last terminal" */ }
  }
  candidates.sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt) || b.runId.localeCompare(a.runId));
  if (candidates.length === 0) throw notFound('last run');
  return candidates[0]!.runDir;
}

/**
 * Save a terminal run exactly as executed.
 *
 * There is deliberately no literal-to-parameter inference here. Ad-hoc runs
 * become zero-parameter definitions. When the source itself came from a saved
 * definition, its already-explicit input/context declarations are preserved
 * from the integrity-pinned definition snapshot.
 */
export async function saveTerminalRunAsWorkflow(
  input: SaveTerminalRunAsWorkflowInput,
): Promise<SaveTerminalRunAsWorkflowResult> {
  const context = requireActorContext(input.context, { requireChat: true });
  const { loaded } = loadOwnedTerminalRunForSave(input.runDir, context);

  const compileOptions = exactCompileOptions(
    loaded,
    input.allowDraft === true,
    input.acknowledgeUnsafeLiterals === true,
  );
  const compiled = compileSavedWorkflowFromRun(input.runDir, compileOptions);

  if (input.workflowId !== undefined) {
    let metadata: SavedWorkflowMetadata;
    try {
      metadata = await readSavedWorkflowMetadata(input.dataDir, input.workflowId);
    } catch (err) {
      if (err instanceof SavedWorkflowNotFoundError) throw notFound(input.workflowId);
      throw err;
    }
    if (!sameOwner(metadata.owner, context.actor)) {
      throw new SavedWorkflowPermissionError(metadata.workflowId);
    }
    assertMetadataVisibleInContext(metadata, context);
    const written = await appendSavedWorkflowRevision(input.dataDir, input.workflowId, {
      actor: context.actor,
      revision: compiled.revision,
      publish: compiled.publish,
      expectedLatestRevision: input.expectedLatestRevision,
      now: input.now,
    });
    return { ...written, sourceStatus: compiled.sourceStatus, created: false };
  }

  const scope: SavedWorkflowScope = input.scope === 'global'
    ? { kind: 'global' }
    : { kind: 'chat', chatId: context.chatId! };
  const written = await createSavedWorkflow(input.dataDir, {
    displayName: input.displayName ?? compiled.displayName,
    aliases: input.aliases,
    owner: context.actor,
    scope,
    revision: compiled.revision,
    publish: compiled.publish,
    now: input.now,
  });
  return { ...written, sourceStatus: compiled.sourceStatus, created: true };
}

/** List the current chat's workflows plus global workflows. */
export async function listVisibleSavedWorkflows(
  input: ListVisibleSavedWorkflowsInput,
): Promise<SavedWorkflowListResult> {
  const context = requireActorContext(input.context);
  const listed = await listSavedWorkflows(input.dataDir, {
    chatId: context.chatId,
    actor: context.actor,
    includeArchived: input.includeArchived,
    includeDrafts: input.includeDrafts,
  });
  // Archived definitions are management state, not a shared catalog surface.
  // Even when explicitly requested, only their owner sees them.
  return {
    ...listed,
    entries: listed.entries.filter((metadata) =>
      metadata.status !== 'archived' || sameOwner(metadata.owner, context.actor)),
  };
}

/**
 * Resolve a visible id/name/alias. Exact workflowId wins; names never silently
 * prefer chat over global, so a collision is returned as an explicit error.
 */
export async function resolveVisibleSavedWorkflow(
  input: ResolveVisibleSavedWorkflowInput,
): Promise<SavedWorkflowMetadata> {
  const ref = input.ref.trim();
  if (!ref) {
    throw new SavedWorkflowServiceError('invalid_context', 'Saved Workflow reference must not be empty');
  }
  const listed = await listVisibleSavedWorkflows(input);
  if (SAVED_WORKFLOW_ID_RE.test(ref)) {
    const exact = listed.entries.find((entry) => entry.workflowId === ref);
    if (exact) return exact;
    throw notFound(ref);
  }

  const key = normalizeSavedWorkflowLookupKey(ref);
  const matches = listed.entries.filter((metadata) =>
    normalizeSavedWorkflowLookupKey(metadata.displayName) === key ||
    metadata.aliases.some((alias) => normalizeSavedWorkflowLookupKey(alias) === key));
  if (matches.length === 0) throw notFound(ref);
  if (matches.length > 1) {
    throw new SavedWorkflowServiceError(
      'ambiguous',
      `Saved Workflow reference ${JSON.stringify(ref)} is ambiguous; use a workflowId`,
      matches,
    );
  }
  return matches[0]!;
}

/** Resolve the active revision and atomically materialize a fresh authorized run. */
export async function instantiatePublishedSavedWorkflow(
  input: InstantiatePublishedSavedWorkflowInput,
): Promise<MaterializedSavedWorkflowRun> {
  const context = requireActorContext(input.context, { requireChat: true });
  const resolved = await resolveVisibleSavedWorkflow({
    dataDir: input.dataDir,
    ref: input.ref,
    context,
    includeDrafts: true,
  });
  if (resolved.status !== 'active' || !resolved.publishedRevision) {
    throw new SavedWorkflowServiceError(
      'not_published',
      `Saved Workflow '${resolved.workflowId}' has no published revision`,
    );
  }

  let current;
  try {
    current = await loadCurrentSavedWorkflow(input.dataDir, resolved.workflowId, {
      revision: 'published',
      requireActive: true,
    });
  } catch (err) {
    if (err instanceof SavedWorkflowNotFoundError) throw notFound(resolved.workflowId);
    if (err instanceof SavedWorkflowConflictError) {
      throw new SavedWorkflowServiceError(
        'not_published',
        `Saved Workflow '${resolved.workflowId}' no longer has an active published revision`,
      );
    }
    throw err;
  }
  // Re-check after the second store read so an archive/scope race cannot make a
  // definition executable after it ceased to be visible to this caller.
  assertMetadataVisibleInContext(current.metadata, context);
  if (current.metadata.status !== 'active' || !current.metadata.publishedRevision) {
    throw new SavedWorkflowServiceError(
      'not_published',
      `Saved Workflow '${current.metadata.workflowId}' has no published revision`,
    );
  }

  return materializeSavedWorkflowRun({
    metadata: current.metadata,
    revision: current.revision,
    rawParams: input.rawParams,
    context: {
      initiatorOpenId: context.actor.openId,
      chatBinding: {
        larkAppId: context.actor.larkAppId,
        chatId: context.chatId!,
        ...(context.rootMessageId ? { rootMessageId: context.rootMessageId } : {}),
        ...(context.sessionId ? { sessionId: context.sessionId } : {}),
        ownerOpenId: context.actor.openId,
      },
    },
    bots: input.bots,
    baseDir: input.baseDir,
    runId: input.runId,
    now: input.now,
  });
}

function requireActorContext(
  context: SavedWorkflowActorContext,
  opts: { requireChat?: boolean } = {},
): SavedWorkflowActorContext {
  if (!context?.actor?.openId?.trim() || !context.actor.larkAppId?.trim()) {
    throw new SavedWorkflowServiceError(
      'invalid_context',
      'Saved Workflow actor requires non-empty openId and larkAppId',
    );
  }
  if (context.chatId !== undefined && !context.chatId.trim()) {
    throw new SavedWorkflowServiceError('invalid_context', 'Saved Workflow chatId must not be empty');
  }
  if (opts.requireChat && !context.chatId) {
    throw new SavedWorkflowServiceError('invalid_context', 'This Saved Workflow operation requires a chat context');
  }
  return context;
}

function sameOwner(a: SavedWorkflowOwner, b: SavedWorkflowOwner): boolean {
  return a.openId === b.openId && a.larkAppId === b.larkAppId;
}

function assertSourceOwnedByCaller(
  loaded: LoadedAuthorizedV3Run,
  context: SavedWorkflowActorContext,
): void {
  const binding = loaded.envelope.chatBinding;
  if (!binding) {
    throw new SavedWorkflowServiceError(
      'source_not_owned',
      `Source run '${loaded.envelope.runId}' has no authenticated chat owner binding`,
    );
  }
  if (binding.chatId !== context.chatId) {
    throw new SavedWorkflowServiceError(
      'scope_mismatch',
      `Source run '${loaded.envelope.runId}' belongs to a different chat`,
    );
  }
  if (
    binding.larkAppId !== context.actor.larkAppId ||
    !binding.ownerOpenId ||
    binding.ownerOpenId !== context.actor.openId
  ) {
    throw new SavedWorkflowServiceError(
      'source_not_owned',
      `Source run '${loaded.envelope.runId}' belongs to a different actor`,
    );
  }
}

function assertMetadataVisibleInContext(
  metadata: SavedWorkflowMetadata,
  context: SavedWorkflowActorContext,
): void {
  if (metadata.status === 'archived') throw notFound(metadata.workflowId);
  if (metadata.scope.kind === 'chat' && metadata.scope.chatId !== context.chatId) {
    throw new SavedWorkflowServiceError(
      'scope_mismatch',
      `Saved Workflow '${metadata.workflowId}' belongs to a different chat`,
    );
  }
  if (metadata.status === 'draft' && !sameOwner(metadata.owner, context.actor)) {
    throw notFound(metadata.workflowId);
  }
}

function exactCompileOptions(
  loaded: LoadedAuthorizedV3Run,
  allowDraft: boolean,
  acknowledgeUnsafeLiterals = false,
): CompileSavedWorkflowFromRunOptions {
  const opts: CompileSavedWorkflowFromRunOptions = { allowDraft, acknowledgeUnsafeLiterals };
  if (loaded.envelope.source.kind !== 'saved_definition') return opts;

  const snapshot = loaded.definitionSnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    throw new Error('cannot save workflow: saved-definition source has no valid definition snapshot');
  }
  const record = snapshot as Record<string, unknown>;
  const payload = validateSavedWorkflowRevisionPayload(record.definition);
  const source = loaded.envelope.source;
  if (
    record.workflowId !== source.workflowId ||
    record.revisionId !== source.revisionId ||
    record.humanVersion !== source.humanVersion ||
    payload.workflowId !== source.workflowId ||
    payload.humanVersion !== source.humanVersion
  ) {
    throw new Error('cannot save workflow: definition snapshot identity does not match run envelope');
  }
  opts.inputs = payload.inputs;
  opts.contextRefs = payload.contextRefs;
  opts.specStatus = payload.specStatus;
  return opts;
}

function notFound(ref: string): SavedWorkflowServiceError {
  return new SavedWorkflowServiceError(
    'not_found',
    `Saved Workflow ${JSON.stringify(ref)} was not found in the current scope`,
  );
}
