/**
 * Filesystem store for v3 Saved Workflows.
 *
 * The caller always supplies `dataDir`; this store never consults HOME/cwd and
 * therefore cannot accidentally mix the new library with the legacy workflow
 * search paths. Mutable metadata updates are locked + atomic. Revision files
 * are immutable, content-addressed, and installed without replacement.
 */

import { constants as fsConstants, promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { atomicWriteFile } from '../../utils/atomic-write.js';
import { withFileLock } from '../../utils/file-lock.js';
import {
  SAVED_WORKFLOW_ID_RE,
  SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
  SAVED_WORKFLOW_REVISION_ID_RE,
  buildSavedWorkflowRevision,
  canonicalJsonStringify,
  loadSavedWorkflowRevision,
  mintSavedWorkflowId,
  normalizeSavedWorkflowLookupKey,
  validateSavedWorkflowMetadata,
  type LoadedSavedWorkflowRevision,
  type SavedWorkflowMetadata,
  type SavedWorkflowOwner,
  type SavedWorkflowRevisionDraft,
  type SavedWorkflowRevisionPayloadV1,
  type SavedWorkflowScope,
  type StoredSavedWorkflowRevision,
} from './library-schema.js';

const LIBRARY_DIR = 'workflow-library';
const METADATA_FILE = 'metadata.json';
const REVISIONS_DIR = 'revisions';

export class SavedWorkflowNotFoundError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Saved workflow '${workflowId}' not found`);
    this.name = 'SavedWorkflowNotFoundError';
  }
}

export class SavedWorkflowPermissionError extends Error {
  constructor(public readonly workflowId: string) {
    super(`Only the owner may modify saved workflow '${workflowId}'`);
    this.name = 'SavedWorkflowPermissionError';
  }
}

export class SavedWorkflowConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SavedWorkflowConflictError';
  }
}

export interface CreateSavedWorkflowInput {
  displayName: string;
  aliases?: string[];
  owner: SavedWorkflowOwner;
  scope: SavedWorkflowScope;
  revision: SavedWorkflowRevisionDraft;
  /** true => immediately runnable; false => draft-only. Defaults to true. */
  publish?: boolean;
  /** Test/import seam. Production callers let the store mint the id. */
  workflowId?: string;
  now?: Date;
}

export interface AppendSavedWorkflowRevisionInput {
  actor: SavedWorkflowOwner;
  revision: SavedWorkflowRevisionDraft;
  publish?: boolean;
  /** Optimistic concurrency guard. */
  expectedLatestRevision?: string;
  now?: Date;
}

export interface SavedWorkflowWriteResult {
  metadata: SavedWorkflowMetadata;
  revision: LoadedSavedWorkflowRevision;
}

export interface ListSavedWorkflowOptions {
  chatId?: string;
  actor?: SavedWorkflowOwner;
  includeArchived?: boolean;
  /** Draft-only workflows are owner-visible by default; this can suppress them. */
  includeDrafts?: boolean;
}

export interface SavedWorkflowListResult {
  entries: SavedWorkflowMetadata[];
  invalid: Array<{ workflowId: string; error: string }>;
}

export type SavedWorkflowResolution =
  | { kind: 'not_found' }
  | { kind: 'resolved'; metadata: SavedWorkflowMetadata }
  | { kind: 'ambiguous'; matches: SavedWorkflowMetadata[] };

export function workflowLibraryRoot(dataDir: string): string {
  if (!dataDir) throw new Error('dataDir is required');
  return join(dataDir, LIBRARY_DIR);
}

export function savedWorkflowDir(dataDir: string, workflowId: string): string {
  assertWorkflowId(workflowId);
  return join(workflowLibraryRoot(dataDir), workflowId);
}

export function savedWorkflowMetadataPath(dataDir: string, workflowId: string): string {
  return join(savedWorkflowDir(dataDir, workflowId), METADATA_FILE);
}

export function savedWorkflowRevisionPath(dataDir: string, workflowId: string, revisionId: string): string {
  assertRevisionId(revisionId);
  return join(savedWorkflowDir(dataDir, workflowId), REVISIONS_DIR, `${revisionId}.json`);
}

function assertWorkflowId(workflowId: string): void {
  if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) {
    throw new Error(`Invalid saved workflow id: ${JSON.stringify(workflowId)}`);
  }
}

function assertRevisionId(revisionId: string): void {
  if (!SAVED_WORKFLOW_REVISION_ID_RE.test(revisionId)) {
    throw new Error(`Invalid saved workflow revision id: ${JSON.stringify(revisionId)}`);
  }
}

function sameOwner(a: SavedWorkflowOwner | undefined, b: SavedWorkflowOwner): boolean {
  return !!a && a.openId === b.openId && a.larkAppId === b.larkAppId;
}

function assertOwner(metadata: SavedWorkflowMetadata, actor: SavedWorkflowOwner): void {
  if (!sameOwner(metadata.owner, actor)) throw new SavedWorkflowPermissionError(metadata.workflowId);
}

function buildRevisionPayload(
  workflowId: string,
  humanVersion: number,
  createdAt: string,
  createdBy: SavedWorkflowOwner,
  draft: SavedWorkflowRevisionDraft,
): SavedWorkflowRevisionPayloadV1 {
  return {
    ...draft,
    workflowId,
    humanVersion,
    createdAt,
    createdBy,
  };
}

function loadedFromStored(stored: StoredSavedWorkflowRevision): LoadedSavedWorkflowRevision {
  return loadSavedWorkflowRevision(stored, {
    workflowId: (stored.payload as SavedWorkflowRevisionPayloadV1).workflowId,
    revisionId: stored.revisionId,
  });
}

export async function createSavedWorkflow(
  dataDir: string,
  input: CreateSavedWorkflowInput,
): Promise<SavedWorkflowWriteResult> {
  const workflowId = input.workflowId ?? mintSavedWorkflowId();
  assertWorkflowId(workflowId);
  const now = (input.now ?? new Date()).toISOString();
  const stored = buildSavedWorkflowRevision(
    buildRevisionPayload(workflowId, 1, now, input.owner, input.revision),
  );
  const publish = input.publish !== false;
  const metadata = validateSavedWorkflowMetadata({
    schemaVersion: SAVED_WORKFLOW_METADATA_SCHEMA_VERSION,
    workflowId,
    displayName: input.displayName,
    aliases: input.aliases ?? [],
    owner: input.owner,
    scope: input.scope,
    status: publish ? 'active' : 'draft',
    latestRevision: stored.revisionId,
    ...(publish ? { publishedRevision: stored.revisionId } : {}),
    createdAt: now,
    updatedAt: now,
  });

  const root = workflowLibraryRoot(dataDir);
  const dir = savedWorkflowDir(dataDir, workflowId);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' already exists`);
    }
    throw err;
  }

  try {
    await fs.mkdir(join(dir, REVISIONS_DIR), { mode: 0o700 });
    await writeImmutableRevision(dataDir, workflowId, stored);
    await writeMetadata(dataDir, metadata);
  } catch (err) {
    // The id was newly allocated by this call. A failed create is not visible
    // through metadata, so remove its private partial directory best-effort.
    try { await fs.rm(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    throw err;
  }

  return { metadata, revision: loadedFromStored(stored) };
}

export async function readSavedWorkflowMetadata(
  dataDir: string,
  workflowId: string,
): Promise<SavedWorkflowMetadata> {
  const path = savedWorkflowMetadataPath(dataDir, workflowId);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new SavedWorkflowNotFoundError(workflowId);
    throw err;
  }
  return validateSavedWorkflowMetadata(JSON.parse(raw));
}

export async function readSavedWorkflowRevision(
  dataDir: string,
  workflowId: string,
  revisionId: string,
): Promise<LoadedSavedWorkflowRevision> {
  const path = savedWorkflowRevisionPath(dataDir, workflowId, revisionId);
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SavedWorkflowNotFoundError(`${workflowId}@${revisionId}`);
    }
    throw err;
  }
  return loadSavedWorkflowRevision(JSON.parse(raw), { workflowId, revisionId });
}

export async function loadCurrentSavedWorkflow(
  dataDir: string,
  workflowId: string,
  opts: { revision?: 'latest' | 'published'; requireActive?: boolean } = {},
): Promise<{ metadata: SavedWorkflowMetadata; revision: LoadedSavedWorkflowRevision }> {
  const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
  const usePublished = (opts.revision ?? 'published') === 'published';
  if (opts.requireActive !== false && (metadata.status !== 'active' || !metadata.publishedRevision)) {
    throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' is not active`);
  }
  const revisionId = usePublished ? metadata.publishedRevision : metadata.latestRevision;
  if (!revisionId) throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' has no published revision`);
  return { metadata, revision: await readSavedWorkflowRevision(dataDir, workflowId, revisionId) };
}

export async function appendSavedWorkflowRevision(
  dataDir: string,
  workflowId: string,
  input: AppendSavedWorkflowRevisionInput,
): Promise<SavedWorkflowWriteResult> {
  const metadataPath = savedWorkflowMetadataPath(dataDir, workflowId);
  return withFileLock(metadataPath, async () => {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    assertOwner(metadata, input.actor);
    if (metadata.status === 'archived') {
      throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' is archived`);
    }
    if (input.expectedLatestRevision && metadata.latestRevision !== input.expectedLatestRevision) {
      throw new SavedWorkflowConflictError(
        `Saved workflow '${workflowId}' changed: expected latest ${input.expectedLatestRevision}, got ${metadata.latestRevision}`,
      );
    }
    const previous = await readSavedWorkflowRevision(dataDir, workflowId, metadata.latestRevision);
    const now = (input.now ?? new Date()).toISOString();
    const stored = buildSavedWorkflowRevision(
      buildRevisionPayload(
        workflowId,
        previous.payload.humanVersion + 1,
        now,
        input.actor,
        input.revision,
      ),
    );
    await writeImmutableRevision(dataDir, workflowId, stored);
    const publish = input.publish === true;
    const next = validateSavedWorkflowMetadata({
      ...metadata,
      latestRevision: stored.revisionId,
      ...(publish ? { publishedRevision: stored.revisionId } : {}),
      status: publish || metadata.publishedRevision ? 'active' : 'draft',
      updatedAt: now,
    });
    await writeMetadata(dataDir, next);
    return { metadata: next, revision: loadedFromStored(stored) };
  });
}

/** Publish an already-saved latest draft without creating a new revision. */
export async function publishLatestSavedWorkflow(
  dataDir: string,
  workflowId: string,
  input: { actor: SavedWorkflowOwner; expectedLatestRevision?: string; now?: Date },
): Promise<SavedWorkflowMetadata> {
  const metadataPath = savedWorkflowMetadataPath(dataDir, workflowId);
  return withFileLock(metadataPath, async () => {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    assertOwner(metadata, input.actor);
    if (metadata.status === 'archived') throw new SavedWorkflowConflictError(`Saved workflow '${workflowId}' is archived`);
    if (input.expectedLatestRevision && input.expectedLatestRevision !== metadata.latestRevision) {
      throw new SavedWorkflowConflictError(
        `Saved workflow '${workflowId}' changed: expected latest ${input.expectedLatestRevision}, got ${metadata.latestRevision}`,
      );
    }
    // Validate the target before exposing it as runnable.
    await readSavedWorkflowRevision(dataDir, workflowId, metadata.latestRevision);
    const next = validateSavedWorkflowMetadata({
      ...metadata,
      status: 'active',
      publishedRevision: metadata.latestRevision,
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    await writeMetadata(dataDir, next);
    return next;
  });
}

export async function archiveSavedWorkflow(
  dataDir: string,
  workflowId: string,
  input: { actor: SavedWorkflowOwner; now?: Date },
): Promise<SavedWorkflowMetadata> {
  const metadataPath = savedWorkflowMetadataPath(dataDir, workflowId);
  return withFileLock(metadataPath, async () => {
    const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
    assertOwner(metadata, input.actor);
    const next = validateSavedWorkflowMetadata({
      ...metadata,
      status: 'archived',
      updatedAt: (input.now ?? new Date()).toISOString(),
    });
    await writeMetadata(dataDir, next);
    return next;
  });
}

export async function listSavedWorkflows(
  dataDir: string,
  opts: ListSavedWorkflowOptions = {},
): Promise<SavedWorkflowListResult> {
  const root = workflowLibraryRoot(dataDir);
  let names: string[];
  try {
    names = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { entries: [], invalid: [] };
    throw err;
  }
  const entries: SavedWorkflowMetadata[] = [];
  const invalid: Array<{ workflowId: string; error: string }> = [];
  for (const workflowId of names.sort()) {
    if (!SAVED_WORKFLOW_ID_RE.test(workflowId)) continue;
    try {
      const metadata = await readSavedWorkflowMetadata(dataDir, workflowId);
      if (!isVisible(metadata, opts)) continue;
      entries.push(metadata);
    } catch (err) {
      invalid.push({ workflowId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  entries.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.workflowId.localeCompare(b.workflowId));
  return { entries, invalid };
}

function isVisible(metadata: SavedWorkflowMetadata, opts: ListSavedWorkflowOptions): boolean {
  if (metadata.status === 'archived' && opts.includeArchived !== true) return false;
  if (metadata.scope.kind === 'chat' && metadata.scope.chatId !== opts.chatId) return false;
  if (metadata.status === 'draft') {
    if (opts.includeDrafts === false) return false;
    if (!sameOwner(opts.actor, metadata.owner)) return false;
  }
  return true;
}

export async function resolveSavedWorkflowRef(
  dataDir: string,
  ref: string,
  opts: ListSavedWorkflowOptions = {},
): Promise<SavedWorkflowResolution> {
  const normalized = normalizeSavedWorkflowLookupKey(ref);
  const { entries } = await listSavedWorkflows(dataDir, opts);
  const matches = entries.filter((metadata) =>
    metadata.workflowId === ref ||
    normalizeSavedWorkflowLookupKey(metadata.displayName) === normalized ||
    metadata.aliases.some((alias) => normalizeSavedWorkflowLookupKey(alias) === normalized));
  if (matches.length === 0) return { kind: 'not_found' };
  if (matches.length > 1) return { kind: 'ambiguous', matches };
  return { kind: 'resolved', metadata: matches[0]! };
}

async function writeMetadata(dataDir: string, metadata: SavedWorkflowMetadata): Promise<void> {
  const normalized = validateSavedWorkflowMetadata(metadata);
  await atomicWriteFile(
    savedWorkflowMetadataPath(dataDir, normalized.workflowId),
    `${canonicalJsonStringify(normalized)}\n`,
    { mode: 0o600 },
  );
}

/**
 * Install a completed sibling temp file via hard-link. `link` is atomic and
 * refuses replacement, unlike rename(2). The metadata lock serializes normal
 * writers; the EEXIST comparison keeps retries idempotent and detects tamper.
 */
async function writeImmutableRevision(
  dataDir: string,
  workflowId: string,
  revision: StoredSavedWorkflowRevision,
): Promise<void> {
  const target = savedWorkflowRevisionPath(dataDir, workflowId, revision.revisionId);
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const encoded = `${canonicalJsonStringify(revision)}\n`;
  try {
    await fs.writeFile(tmp, encoded, { flag: 'wx', mode: 0o600 });
    await fs.chmod(tmp, 0o600);
    try {
      await fs.link(tmp, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const existing = await fs.readFile(target, 'utf-8');
      if (existing !== encoded) {
        throw new SavedWorkflowConflictError(
          `Immutable revision ${revision.revisionId} already exists with different content`,
        );
      }
    }
  } finally {
    try { await fs.unlink(tmp); } catch { /* best effort */ }
  }

  // Defense-in-depth: ensure the installed target is readable before a
  // metadata pointer can expose it. access() also catches a failed link on odd
  // filesystems before the pointer update.
  await fs.access(target, fsConstants.R_OK);
}
