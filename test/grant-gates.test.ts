/**
 * 闸门接入：chatGrant 仅放行 canTalk，不放行 canOperate。
 * Run: pnpm vitest run test/grant-gates.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

import { registerBot, getBot } from '../src/bot-registry.js';
import { canTalk, canOperate } from '../src/im/lark/event-dispatcher.js';

describe('grant gates', () => {
  beforeEach(() => {
    const bot = registerBot({ larkAppId: 'g1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] });
    bot.resolvedAllowedUsers = ['ou_owner'];
    bot.config.chatGrants = { oc_1: ['ou_guest'] };
  });

  it('chatGrant grants canTalk in that chat only', () => {
    expect(canTalk('g1', 'oc_1', 'ou_guest')).toBe(true);
    expect(canTalk('g1', 'oc_2', 'ou_guest')).toBe(false);
  });

  it('chatGrant does NOT grant canOperate', () => {
    expect(canOperate('g1', 'oc_1', 'ou_guest')).toBe(false);
    expect(canOperate('g1', 'oc_1', 'ou_owner')).toBe(true);
  });

  it('allowed user still talks & operates everywhere', () => {
    expect(canTalk('g1', 'oc_9', 'ou_owner')).toBe(true);
    expect(canOperate('g1', 'oc_9', 'ou_owner')).toBe(true);
  });
});
