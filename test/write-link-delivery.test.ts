/**
 * Unit tests for deliverWriteLinkCard (worker-pool.ts) — how the write-enabled
 * session card ("DM 卡") reaches the operator who clicked 「获取操作链接」.
 *
 * Behaviour under test (方案 A): prefer an in-chat "visible-to-you" ephemeral
 * card, but Feishu's ephemeral API only works in plain `group` chats (topic /
 * thread groups reject with 18053, p2p unsupported). chatType can't tell a topic
 * group from a regular one, so we attempt ephemeral for any non-p2p chat and
 * fall back to a private DM on failure. p2p skips straight to the DM. Both
 * channels are private — the fallback never leaks the write token.
 *
 * Run:  pnpm vitest run test/write-link-delivery.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DaemonSession } from '../src/core/types.js';

const { sendEphemeralCardMock, sendUserMessageMock } = vi.hoisted(() => ({
  sendEphemeralCardMock: vi.fn(),
  sendUserMessageMock: vi.fn(),
}));

vi.mock('../src/bot-registry.js', () => ({
  getBot: vi.fn(() => ({ resolvedAllowedUsers: [], config: {} })),
  getAllBots: vi.fn(() => []),
  resolveBrandLabel: vi.fn(() => undefined),
}));

vi.mock('../src/im/lark/client.js', () => ({
  updateMessage: vi.fn(),
  deleteMessage: vi.fn(),
  sendEphemeralCard: sendEphemeralCardMock,
  sendUserMessage: sendUserMessageMock,
  addReaction: vi.fn(),
  MessageWithdrawnError: class extends Error {},
}));

vi.mock('../src/services/frozen-card-store.js', () => ({
  loadFrozenCards: vi.fn(() => new Map()),
  saveFrozenCards: vi.fn(),
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { deliverWriteLinkCard } from '../src/core/worker-pool.js';

const OP = 'ou_operator';
const CARD = '{"card":"json"}';

const ds = (over: Partial<DaemonSession> = {}) => ({
  larkAppId: 'app',
  chatId: 'oc_here',
  chatType: 'group',
  session: { sessionId: 'sess1234abcd' },
  ...over,
} as unknown as DaemonSession);

beforeEach(() => {
  vi.clearAllMocks();
  sendEphemeralCardMock.mockResolvedValue('eph_msg_id');
  sendUserMessageMock.mockResolvedValue('dm_msg_id');
});

describe('deliverWriteLinkCard', () => {
  it('sends an ephemeral card in a plain group and does NOT DM', async () => {
    const r = await deliverWriteLinkCard(ds({ chatType: 'group' }), OP, CARD);
    expect(r).toBe('ephemeral');
    expect(sendEphemeralCardMock).toHaveBeenCalledWith('app', 'oc_here', OP, CARD);
    expect(sendUserMessageMock).not.toHaveBeenCalled();
  });

  it('falls back to a private DM when the ephemeral API rejects (e.g. topic group 18053)', async () => {
    sendEphemeralCardMock.mockRejectedValueOnce(new Error('chat can not be thread (code: 18053)'));
    const r = await deliverWriteLinkCard(ds({ chatType: 'group' }), OP, CARD);
    expect(r).toBe('dm');
    expect(sendEphemeralCardMock).toHaveBeenCalledTimes(1);
    expect(sendUserMessageMock).toHaveBeenCalledWith('app', OP, CARD, 'interactive');
  });

  it('skips ephemeral entirely for p2p chats and DMs directly', async () => {
    const r = await deliverWriteLinkCard(ds({ chatType: 'p2p' }), OP, CARD);
    expect(r).toBe('dm');
    expect(sendEphemeralCardMock).not.toHaveBeenCalled();
    expect(sendUserMessageMock).toHaveBeenCalledWith('app', OP, CARD, 'interactive');
  });

  it('returns "failed" when both the ephemeral attempt and the DM fallback error', async () => {
    sendEphemeralCardMock.mockRejectedValueOnce(new Error('18053'));
    sendUserMessageMock.mockRejectedValueOnce(new Error('bot not in chat'));
    const r = await deliverWriteLinkCard(ds({ chatType: 'group' }), OP, CARD);
    expect(r).toBe('failed');
  });
});
