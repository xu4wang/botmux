import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readProcessStartIdentity } from '../src/core/session-marker.js';

import {
  assertAgentFacingAppendScope,
  assertAgentFacingSaveScope,
  assertDaemonManagedRunBaseDir,
  collectSavedWorkflowRawParams,
  contextFromEnv,
} from '../src/cli/saved-workflow.js';

describe('Saved Workflow CLI param parsing', () => {
  it('accepts explicit and bare key=value inputs into an own-property-only map', () => {
    const parsed = collectSavedWorkflowRawParams([
      'weekly-report',
      '--param',
      'city=上海',
      '--param=dry_run=true',
      'note=a=b',
    ]);

    expect(Object.getPrototypeOf(parsed)).toBeNull();
    expect(parsed).toEqual({
      city: { kind: 'string', value: '上海' },
      dry_run: { kind: 'string', value: 'true' },
      note: { kind: 'string', value: 'a=b' },
    });
  });

  it('does not treat option values containing equals signs as params', () => {
    const parsed = collectSavedWorkflowRawParams([
      'weekly-report',
      '--library-dir',
      '/tmp/library=staging',
      '--base-dir=/tmp/runs=staging',
      '--run-id',
      'run=id',
      'city=上海',
    ]);

    expect(Object.keys(parsed)).toEqual(['city']);
    expect(parsed.city).toEqual({ kind: 'string', value: '上海' });
  });

  it('parses object/array values only through --param-json', () => {
    const parsed = collectSavedWorkflowRawParams([
      'weekly-report',
      '--param-json',
      'filters={"region":"cn"}',
      '--param-json=tags=["a","b"]',
    ]);
    expect(parsed.filters).toEqual({ kind: 'json', value: { region: 'cn' } });
    expect(parsed.tags).toEqual({ kind: 'json', value: ['a', 'b'] });
    expect(() => collectSavedWorkflowRawParams([
      'weekly-report', '--param-json', 'filters={broken',
    ])).toThrow(/--param-json filters 不是有效 JSON/);
  });

  it.each(['bad-name=x', '9starts_with_digit=x', '__proto__=x', 'prototype=x', 'constructor=x'])(
    'rejects unsafe parameter name %s',
    (pair) => {
      expect(() => collectSavedWorkflowRawParams(['weekly-report', pair])).toThrow(/参数名非法/);
    },
  );

  it('rejects duplicate params across explicit and bare forms', () => {
    expect(() => collectSavedWorkflowRawParams([
      'weekly-report',
      '--param',
      'city=上海',
      'city=北京',
    ])).toThrow(/参数重复：city/);
  });
});

describe('Saved Workflow CLI current-turn authentication', () => {
  it('uses session.lastCallerOpenId and durable routing, never static owner/env routing', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'saved-workflow-turn-'));
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(
        join(dataDir, '.botmux-cli-pids', String(process.pid)),
        JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-b', procStart }),
      );
      writeFileSync(join(dataDir, 'sessions-cli_real.json'), JSON.stringify({
        'sess-1': {
          sessionId: 'sess-1',
          status: 'active',
          scope: 'thread',
          larkAppId: 'cli_real',
          chatId: 'oc_real',
          rootMessageId: 'om_real',
          ownerOpenId: 'ou_owner_a',
          lastCallerOpenId: 'ou_caller_b',
          quoteTargetId: 'turn-b',
        },
      }));

      expect(contextFromEnv({
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_OWNER_OPEN_ID: 'ou_owner_a',
        BOTMUX_LARK_APP_ID: 'cli_stale',
        BOTMUX_CHAT_ID: 'oc_stale',
        BOTMUX_ROOT_MESSAGE_ID: 'om_stale',
      } as NodeJS.ProcessEnv, process.pid)).toEqual({
        actor: { larkAppId: 'cli_real', openId: 'ou_caller_b' },
        chatId: 'oc_real',
        rootMessageId: 'om_real',
        sessionId: 'sess-1',
      });
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('rejects a stale marker even when inherited owner/session env looks valid', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'saved-workflow-turn-'));
    try {
      mkdirSync(join(dataDir, '.botmux-cli-pids'), { recursive: true });
      const procStart = readProcessStartIdentity(process.pid);
      if (!procStart) throw new Error('test process start identity unavailable');
      writeFileSync(
        join(dataDir, '.botmux-cli-pids', String(process.pid)),
        JSON.stringify({ sessionId: 'sess-1', turnId: 'turn-old', procStart }),
      );
      writeFileSync(join(dataDir, 'sessions-cli_real.json'), JSON.stringify({
        'sess-1': {
          sessionId: 'sess-1', status: 'active', scope: 'thread',
          larkAppId: 'cli_real', chatId: 'oc_real', rootMessageId: 'om_real',
          ownerOpenId: 'ou_owner_a', lastCallerOpenId: 'ou_caller_b', quoteTargetId: 'turn-new',
        },
      }));

      expect(() => contextFromEnv({
        SESSION_DATA_DIR: dataDir,
        BOTMUX_SESSION_ID: 'sess-1',
        BOTMUX_OWNER_OPEN_ID: 'ou_owner_a',
      } as NodeJS.ProcessEnv, process.pid)).toThrow(/turn-old.*turn-new/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});

describe('Saved Workflow CLI daemon-managed run root', () => {
  it('rejects a custom run root that the daemon cannot resolve', () => {
    expect(() => assertDaemonManagedRunBaseDir('/tmp/custom-runs', '/tmp/canonical-runs'))
      .toThrow(/不支持自定义 --base-dir/);
    expect(() => assertDaemonManagedRunBaseDir('/tmp/canonical-runs/.', '/tmp/canonical-runs'))
      .not.toThrow();
  });
});

describe('Saved Workflow CLI scope authorization', () => {
  it('keeps agent-facing saves chat-scoped and delegates global authorization to IM', () => {
    expect(() => assertAgentFacingSaveScope(['last', '周报'])).not.toThrow();
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--global']))
      .toThrow(/飞书中显式发送.*daemon 校验 canOperate/);
    expect(() => assertAgentFacingSaveScope(['last', '周报', '--ack-unsafe']))
      .toThrow(/agent 不能代替用户确认.*用户在飞书中显式发送/);
  });

  it('rejects appending a revision to an existing global definition', async () => {
    const loadCurrent = async () => ({
      metadata: { scope: { kind: 'global' as const } },
      revision: {},
    });
    await expect(assertAgentFacingAppendScope('/tmp/library', 'wf_deadbeef', loadCurrent as any))
      .rejects.toThrow(/不能修改 global Saved Workflow.*canOperate/);
  });

  it('allows appending a revision to a chat-scoped definition', async () => {
    const loadCurrent = async () => ({
      metadata: { scope: { kind: 'chat' as const, chatId: 'oc_1' } },
      revision: {},
    });
    await expect(assertAgentFacingAppendScope('/tmp/library', 'wf_deadbeef', loadCurrent as any))
      .resolves.toBeUndefined();
  });
});
