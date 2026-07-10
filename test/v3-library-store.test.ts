import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  SavedWorkflowConflictError,
  SavedWorkflowPermissionError,
  appendSavedWorkflowRevision,
  archiveSavedWorkflow,
  createSavedWorkflow,
  listSavedWorkflows,
  loadCurrentSavedWorkflow,
  publishLatestSavedWorkflow,
  readSavedWorkflowRevision,
  resolveSavedWorkflowRef,
  savedWorkflowMetadataPath,
  savedWorkflowRevisionPath,
  workflowLibraryRoot,
} from '../src/workflows/v3/library-store.js';
import {
  computeSavedWorkflowGateDigest,
  type SavedWorkflowOwner,
  type SavedWorkflowRevisionDraft,
  type V3DagTemplate,
} from '../src/workflows/v3/library-schema.js';

const OWNER: SavedWorkflowOwner = { openId: 'ou_owner', larkAppId: 'cli_owner' };
const OTHER: SavedWorkflowOwner = { openId: 'ou_other', larkAppId: 'cli_owner' };

const IDS = {
  one: 'wf_11111111111111111111111111111111',
  two: 'wf_22222222222222222222222222222222',
  three: 'wf_33333333333333333333333333333333',
  four: 'wf_44444444444444444444444444444444',
};

function revisionDraft(goal = '研究并输出报告', sourceRunId = 'source-run'): SavedWorkflowRevisionDraft {
  const dagTemplate: V3DagTemplate = {
    nodes: [{
      id: 'research',
      type: 'goal',
      goal,
      bot: 'cli_research',
      depends: [],
      inputs: [],
      humanGate: null,
    }],
  };
  return {
    sourceRunId,
    inputs: { topic: { type: 'string', required: true } },
    contextRefs: ['chatId', 'initiatorOpenId'],
    specTemplate: {
      schemaVersion: 1,
      title: '研究报告',
      requirement: goal,
      nodes: [{
        sketchId: 'research',
        goal,
        input_needs: [],
        expected_outputs: ['报告'],
        acceptance: '报告完整',
        risk_gate: false,
        unknowns: [],
      }],
    },
    specStatus: 'current',
    dagTemplate,
    safety: { gateDigest: computeSavedWorkflowGateDigest(dagTemplate), sideEffects: [] },
  };
}

let dataDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-v3-library-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('v3 Saved Workflow library store', () => {
  it('stores Unicode metadata and an immutable revision under the explicit dataDir', async () => {
    const created = await createSavedWorkflow(dataDir, {
      workflowId: IDS.one,
      displayName: '竞品周报',
      aliases: ['每周竞品'],
      owner: OWNER,
      scope: { kind: 'chat', chatId: 'oc_a' },
      revision: revisionDraft(),
      now: new Date('2026-07-10T08:00:00.000Z'),
    });

    expect(workflowLibraryRoot(dataDir)).toBe(join(dataDir, 'workflow-library'));
    expect(created.metadata.displayName).toBe('竞品周报');
    expect(created.metadata.status).toBe('active');
    expect(created.metadata.latestRevision).toBe(created.metadata.publishedRevision);
    expect(JSON.parse(readFileSync(savedWorkflowMetadataPath(dataDir, IDS.one), 'utf-8')).displayName)
      .toBe('竞品周报');
    expect(readFileSync(
      savedWorkflowRevisionPath(dataDir, IDS.one, created.revision.revisionId),
      'utf-8',
    )).toContain(created.revision.contentHash);
  });

  it('keeps latest and published pointers separate until a draft is published', async () => {
    const created = await createSavedWorkflow(dataDir, {
      workflowId: IDS.one,
      displayName: '周报',
      owner: OWNER,
      scope: { kind: 'global' },
      revision: revisionDraft('第一版'),
      now: new Date('2026-07-10T08:00:00.000Z'),
    });
    const appended = await appendSavedWorkflowRevision(dataDir, IDS.one, {
      actor: OWNER,
      expectedLatestRevision: created.metadata.latestRevision,
      revision: revisionDraft('第二版草稿', 'source-run-2'),
      publish: false,
      now: new Date('2026-07-10T09:00:00.000Z'),
    });

    expect(appended.metadata.status).toBe('active');
    expect(appended.metadata.latestRevision).toBe(appended.revision.revisionId);
    expect(appended.metadata.publishedRevision).toBe(created.revision.revisionId);
    expect(appended.revision.payload.humanVersion).toBe(2);
    expect((await loadCurrentSavedWorkflow(dataDir, IDS.one)).revision.revisionId)
      .toBe(created.revision.revisionId);

    const published = await publishLatestSavedWorkflow(dataDir, IDS.one, {
      actor: OWNER,
      expectedLatestRevision: appended.revision.revisionId,
      now: new Date('2026-07-10T10:00:00.000Z'),
    });
    expect(published.publishedRevision).toBe(appended.revision.revisionId);
    expect((await loadCurrentSavedWorkflow(dataDir, IDS.one)).revision.revisionId)
      .toBe(appended.revision.revisionId);
  });

  it('enforces owner-only mutation and preserves history when archiving', async () => {
    const created = await createSavedWorkflow(dataDir, {
      workflowId: IDS.one,
      displayName: '周报',
      owner: OWNER,
      scope: { kind: 'global' },
      revision: revisionDraft(),
      now: new Date('2026-07-10T10:00:00.000Z'),
    });
    await expect(appendSavedWorkflowRevision(dataDir, IDS.one, {
      actor: OTHER,
      revision: revisionDraft('越权修改'),
    })).rejects.toBeInstanceOf(SavedWorkflowPermissionError);

    const archived = await archiveSavedWorkflow(dataDir, IDS.one, {
      actor: OWNER,
      now: new Date('2026-07-10T11:00:00.000Z'),
    });
    expect(archived.status).toBe('archived');
    expect((await readSavedWorkflowRevision(dataDir, IDS.one, created.revision.revisionId)).revisionId)
      .toBe(created.revision.revisionId);
  });

  it('filters chat scope, keeps global visible, and reports ambiguous names instead of guessing', async () => {
    await createSavedWorkflow(dataDir, {
      workflowId: IDS.one,
      displayName: '周报',
      aliases: ['weekly'],
      owner: OWNER,
      scope: { kind: 'global' },
      revision: revisionDraft('global'),
    });
    await createSavedWorkflow(dataDir, {
      workflowId: IDS.two,
      displayName: '周报',
      owner: OWNER,
      scope: { kind: 'chat', chatId: 'oc_a' },
      revision: revisionDraft('chat a'),
    });
    await createSavedWorkflow(dataDir, {
      workflowId: IDS.three,
      displayName: '仅 B 可见',
      owner: OWNER,
      scope: { kind: 'chat', chatId: 'oc_b' },
      revision: revisionDraft('chat b'),
    });

    const inA = await listSavedWorkflows(dataDir, { chatId: 'oc_a', actor: OWNER });
    expect(inA.entries.map((entry) => entry.workflowId).sort()).toEqual([IDS.one, IDS.two]);
    expect(inA.invalid).toEqual([]);
    expect(await resolveSavedWorkflowRef(dataDir, '周报', { chatId: 'oc_a', actor: OWNER }))
      .toMatchObject({ kind: 'ambiguous', matches: [{ workflowId: IDS.one }, { workflowId: IDS.two }] });
    expect(await resolveSavedWorkflowRef(dataDir, 'weekly', { chatId: 'oc_b', actor: OWNER }))
      .toMatchObject({ kind: 'resolved', metadata: { workflowId: IDS.one } });
    expect(await resolveSavedWorkflowRef(dataDir, IDS.three, { chatId: 'oc_a', actor: OWNER }))
      .toEqual({ kind: 'not_found' });
  });

  it('serializes concurrent appends and rejects a stale expectedLatestRevision', async () => {
    const created = await createSavedWorkflow(dataDir, {
      workflowId: IDS.one,
      displayName: '并发流程',
      owner: OWNER,
      scope: { kind: 'global' },
      revision: revisionDraft('v1'),
    });
    const expected = created.metadata.latestRevision;
    const results = await Promise.allSettled([
      appendSavedWorkflowRevision(dataDir, IDS.one, {
        actor: OWNER,
        expectedLatestRevision: expected,
        revision: revisionDraft('v2-a', 'source-a'),
      }),
      appendSavedWorkflowRevision(dataDir, IDS.one, {
        actor: OWNER,
        expectedLatestRevision: expected,
        revision: revisionDraft('v2-b', 'source-b'),
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(SavedWorkflowConflictError);
  });

  it('detects an on-disk immutable revision tamper and reports corrupt catalog entries', async () => {
    const created = await createSavedWorkflow(dataDir, {
      workflowId: IDS.one,
      displayName: '周报',
      owner: OWNER,
      scope: { kind: 'global' },
      revision: revisionDraft(),
    });
    const revisionPath = savedWorkflowRevisionPath(dataDir, IDS.one, created.revision.revisionId);
    const raw = JSON.parse(readFileSync(revisionPath, 'utf-8'));
    raw.payload.sourceRunId = 'tampered';
    writeFileSync(revisionPath, JSON.stringify(raw), 'utf-8');
    await expect(readSavedWorkflowRevision(dataDir, IDS.one, created.revision.revisionId))
      .rejects.toThrow(/contentHash does not match payload/);

    mkdirSync(join(workflowLibraryRoot(dataDir), IDS.four), { recursive: true });
    writeFileSync(savedWorkflowMetadataPath(dataDir, IDS.four), '{broken-json', 'utf-8');
    const listed = await listSavedWorkflows(dataDir, { actor: OWNER });
    expect(listed.invalid).toEqual([expect.objectContaining({ workflowId: IDS.four })]);
  });
});
