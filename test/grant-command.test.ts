/**
 * grant-command 纯函数：从 mention 解析授权目标（排除 bot 自身）。
 * Run: pnpm vitest run test/grant-command.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { parseGrantTarget } from '../src/im/lark/grant-command.js';

describe('parseGrantTarget', () => {
  it('extracts first non-bot human mention', () => {
    const msg = { mentions: [
      { key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Claude' },
      { key: '@_user_2', id: { open_id: 'ou_g' }, name: '张三' },
    ] };
    expect(parseGrantTarget(msg, 'ou_bot')).toEqual({ openId: 'ou_g', name: '张三' });
  });

  it('returns undefined when only the bot itself is mentioned', () => {
    expect(parseGrantTarget({ mentions: [{ id: { open_id: 'ou_bot' }, name: 'Claude' }] }, 'ou_bot')).toBeUndefined();
  });

  it('returns undefined when no mentions', () => {
    expect(parseGrantTarget({ mentions: [] }, 'ou_bot')).toBeUndefined();
    expect(parseGrantTarget({}, 'ou_bot')).toBeUndefined();
  });

  it('falls back to open_id as name when name missing', () => {
    expect(parseGrantTarget({ mentions: [{ id: { open_id: 'ou_x' } }] }, 'ou_bot')).toEqual({ openId: 'ou_x', name: 'ou_x' });
  });
});
