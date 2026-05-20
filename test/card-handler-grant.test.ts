/**
 * card-handler 群内授权动作：owner 强闸门 + nonce 校验。
 * 不传 open_message_id → 跳过 updateMessage，无需 mock 飞书 API。
 * Run: pnpm vitest run test/card-handler-grant.test.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

let configPath: string;
const deps = { activeSessions: new Map(), sessionReply: vi.fn(async () => 'mid'), lastRepoScan: new Map() } as any;

async function fresh() {
  vi.resetModules();
  const registry = await import('../src/bot-registry.js');
  const pending = await import('../src/im/lark/grant-pending.js');
  const handler = await import('../src/im/lark/card-handler.js');
  registry.loadBotConfigs().forEach(c => registry.registerBot(c));
  return { registry, pending, handler };
}

beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'botmux-cardgrant-'));
  configPath = join(dir, 'bots.json');
  writeFileSync(configPath, JSON.stringify([{ larkAppId: 'h1', larkAppSecret: 's', cliId: 'claude-code', allowedUsers: ['ou_owner'] }], null, 2));
  process.env.BOTS_CONFIG = configPath;
});
afterEach(() => { delete process.env.BOTS_CONFIG; vi.restoreAllMocks(); });

describe('card-handler grant actions', () => {
  it('non-owner click is rejected (no grant, owner_only toast)', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    const res = await handler.handleCardAction(
      { operator: { open_id: 'ou_not_owner' }, action: { value: { action: 'grant_chat', target_open_id: 'ou_g', chat_id: 'oc_1', nonce } } } as any,
      deps, 'h1',
    );
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });

  it('owner grant_chat with valid nonce applies and clears pending', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(
      { operator: { open_id: 'ou_owner' }, action: { value: { action: 'grant_chat', target_open_id: 'ou_g', chat_id: 'oc_1', nonce } } } as any,
      deps, 'h1',
    );
    expect(registry.getBot('h1').config.chatGrants).toEqual({ oc_1: ['ou_g'] });
    expect(pending.checkNonce('h1', 'oc_1', 'ou_g', nonce)).toBe(false); // cleared
  });

  it('owner grant_global applies', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(
      { operator: { open_id: 'ou_owner' }, action: { value: { action: 'grant_global', target_open_id: 'ou_g', chat_id: 'oc_1', nonce } } } as any,
      deps, 'h1',
    );
    expect(registry.getBot('h1').resolvedAllowedUsers).toContain('ou_g');
  });

  it('stale nonce → expired toast, no grant', async () => {
    const { registry, handler } = await fresh();
    const res = await handler.handleCardAction(
      { operator: { open_id: 'ou_owner' }, action: { value: { action: 'grant_global', target_open_id: 'ou_g', chat_id: 'oc_1', nonce: 'stale' } } } as any,
      deps, 'h1',
    );
    expect(res?.toast?.type).toBe('error');
    expect(registry.getBot('h1').resolvedAllowedUsers).not.toContain('ou_g');
  });

  it('grant_deny marks denied (throttled), no grant', async () => {
    const { registry, pending, handler } = await fresh();
    const nonce = pending.openPending('h1', 'oc_1', 'ou_g');
    await handler.handleCardAction(
      { operator: { open_id: 'ou_owner' }, action: { value: { action: 'grant_deny', target_open_id: 'ou_g', chat_id: 'oc_1', nonce } } } as any,
      deps, 'h1',
    );
    expect(pending.isThrottled('h1', 'oc_1', 'ou_g')).toBe(true);
    expect(registry.getBot('h1').config.chatGrants).toBeUndefined();
  });
});
