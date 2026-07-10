import { describe, expect, it, vi } from 'vitest';
import {
  authorizeV3SavedWorkflowInvocation,
  deliverV3SavedWorkflowNotification,
  executeV3SavedWorkflowCommand,
  resolveV3SavedWorkflowMessageTargets,
  type V3SavedWorkflowExecutionDeps,
} from '../src/im/lark/v3-saved-workflow-handler.js';

describe('Saved Workflow IM routing', () => {
  it('uses the dispatcher reply root for replies and frozen run binding', () => {
    expect(resolveV3SavedWorkflowMessageTargets({
      anchor: 'oc_chat_must_not_be_bound',
      replyRootId: 'om_real_topic_root',
      messageId: 'om_trigger',
    })).toEqual({
      replyAnchor: 'om_real_topic_root',
      runRootMessageId: 'om_real_topic_root',
      quotaMessageId: 'om_trigger',
    });
  });

  it('falls back separately: replies may use the chat anchor, run.json never does', () => {
    expect(resolveV3SavedWorkflowMessageTargets({
      anchor: 'oc_chat',
      messageId: 'om_trigger',
    })).toEqual({
      replyAnchor: 'oc_chat',
      runRootMessageId: 'om_trigger',
      quotaMessageId: 'om_trigger',
    });
  });

  it('rejects a chat id accidentally supplied as the run message root', () => {
    expect(() => resolveV3SavedWorkflowMessageTargets({
      anchor: 'oc_chat',
      replyRootId: 'oc_not_a_message',
      messageId: 'om_trigger',
    })).toThrow(/message root, not a chat id/);
  });
});

describe('Saved Workflow IM policy', () => {
  it.each([
    { kind: 'list' } as const,
    { kind: 'show', ref: 'Weekly Report' } as const,
    { kind: 'save', source: 'last', global: false, acknowledgeUnsafeLiterals: false } as const,
    { kind: 'run', ref: 'Weekly Report', rawParams: {} } as const,
  ])('charges every accepted verb exactly once: $kind', async (command) => {
    const quota = vi.fn().mockResolvedValue(true);
    await expect(authorizeV3SavedWorkflowInvocation(command, {
      canPublishGlobal: () => true,
      consumeMessageQuotaOnce: quota,
    })).resolves.toEqual({ ok: true });
    expect(quota).toHaveBeenCalledTimes(1);
  });

  it('requires operate permission before publishing global scope', async () => {
    const quota = vi.fn().mockResolvedValue(true);
    await expect(authorizeV3SavedWorkflowInvocation(
      { kind: 'save', source: 'last', global: true, acknowledgeUnsafeLiterals: false },
      { canPublishGlobal: () => false, consumeMessageQuotaOnce: quota },
    )).resolves.toEqual({ ok: false, reason: 'global_requires_operate' });
    expect(quota).not.toHaveBeenCalled();
  });

  it('fails closed when the single shared quota check denies', async () => {
    await expect(authorizeV3SavedWorkflowInvocation(
      { kind: 'run', ref: 'Weekly Report', rawParams: {} },
      { canPublishGlobal: () => true, consumeMessageQuotaOnce: async () => false },
    )).resolves.toEqual({ ok: false, reason: 'quota_denied' });
  });
});

function executionDeps(overrides: Partial<V3SavedWorkflowExecutionDeps> = {}): V3SavedWorkflowExecutionDeps {
  return {
    listVisible: vi.fn(),
    resolveVisible: vi.fn(),
    loadCurrent: vi.fn(),
    resolveOwnedRun: vi.fn(),
    saveRun: vi.fn(),
    instantiate: vi.fn(),
    loadBots: vi.fn(() => []),
    persistStartIntent: vi.fn(),
    driveDetached: vi.fn(),
    ...overrides,
  } as unknown as V3SavedWorkflowExecutionDeps;
}

const EXECUTION_BASE = {
  dataDir: '/tmp/botmux-data',
  baseDir: '/tmp/botmux-data/v3-runs',
  context: {
    actor: { openId: 'ou_owner', larkAppId: 'cli_bot' },
    chatId: 'oc_chat',
    rootMessageId: 'om_root',
  },
};

describe('Saved Workflow execution seam', () => {
  it('returns a committed save notification without owning Lark delivery', async () => {
    const deps = executionDeps({
      resolveOwnedRun: vi.fn().mockResolvedValue('/tmp/source-run'),
      saveRun: vi.fn().mockResolvedValue({
        metadata: {
          displayName: 'Weekly Report',
          workflowId: 'wf_0123456789abcdef0123456789abcdef',
          scope: { kind: 'chat', chatId: 'oc_chat' },
          status: 'active',
        },
        revision: {
          revisionId: 'rev_deadbeef',
          payload: { humanVersion: 1 },
        },
      }),
    });
    const result = await executeV3SavedWorkflowCommand({
      ...EXECUTION_BASE,
      command: {
        kind: 'save', source: 'last', displayName: 'Weekly Report', global: false,
        acknowledgeUnsafeLiterals: true,
      },
    }, deps);
    expect(result.effect).toBe('save_committed');
    expect(result.message).toContain('✅ 已固化 Saved Workflow：Weekly Report');
    expect(deps.saveRun).toHaveBeenCalledTimes(1);
    expect(deps.saveRun).toHaveBeenCalledWith(expect.objectContaining({ acknowledgeUnsafeLiterals: true }));
  });

  it('keeps a started run successful independently of later notification delivery', async () => {
    const deps = executionDeps({
      instantiate: vi.fn().mockResolvedValue({
        runId: 'weekly-260710-120000-000-deadbeef',
        runDir: '/tmp/run',
        envelope: { source: { workflowId: 'wf_abc', humanVersion: 2 } },
      }),
    });
    const result = await executeV3SavedWorkflowCommand({
      ...EXECUTION_BASE,
      command: { kind: 'run', ref: 'Weekly Report', rawParams: {} },
    }, deps);
    expect(result.effect).toBe('run_started');
    expect(deps.persistStartIntent).toHaveBeenCalledTimes(1);
    expect(deps.driveDetached).toHaveBeenCalledTimes(1);
  });

  it('swallows notification transport failure after a committed effect', async () => {
    const onError = vi.fn();
    await expect(deliverV3SavedWorkflowNotification(
      { effect: 'save_committed', message: 'saved' },
      async () => { throw new Error('Lark unavailable'); },
      onError,
    )).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'Lark unavailable' }), 'save_committed');
  });

  it('adds the explicit ad-hoc escape hint to failed run lookup', async () => {
    const deps = executionDeps({
      instantiate: vi.fn().mockRejectedValue(new Error('not found')),
    });
    const result = await executeV3SavedWorkflowCommand({
      ...EXECUTION_BASE,
      command: { kind: 'run', ref: 'run the tests', rawParams: {} },
    }, deps);
    expect(result).toMatchObject({ effect: 'failed' });
    expect(result.message).toContain('/workflow new run ...');
  });

  it('turns reusable-literal lint failures into an actionable --ack-unsafe retry', async () => {
    const deps = executionDeps({
      resolveOwnedRun: vi.fn().mockResolvedValue('/tmp/source-run'),
      saveRun: vi.fn().mockRejectedValue(new Error(
        'Saved Workflow lint requires confirmation: secret-looking literal; explicitly acknowledgeUnsafeLiterals.',
      )),
    });
    const result = await executeV3SavedWorkflowCommand({
      ...EXECUTION_BASE,
      command: {
        kind: 'save', source: 'last', global: false, acknowledgeUnsafeLiterals: false,
      },
    }, deps);
    expect(result.effect).toBe('failed');
    expect(result.message).toContain('--ack-unsafe');
    expect(result.message).toContain('审查/脱敏');
  });
});
