/**
 * Unit tests for the bot-mention dedup module.
 *
 * Pins the atomic check-and-set contract of tryClaimBotMentionMessage: only
 * the first caller within the TTL window may proceed. This is the contract
 * the WS path and the signal-file path both rely on to avoid the
 * "@mention 触发两次" double-enqueue bug — without atomicity, both paths
 * could pass a non-atomic isBotMentionMessageHandled check and both
 * mark/enqueue.
 *
 * Run:  pnpm vitest run test/bot-mention-dedup.test.ts
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  isBotMentionMessageHandled,
  markBotMentionMessageHandled,
  tryClaimBotMentionMessage,
  _resetForTest,
} from '../src/utils/bot-mention-dedup.js';

describe('bot-mention dedup', () => {
  beforeEach(() => _resetForTest());

  it('tryClaim returns true the first time and false thereafter', () => {
    expect(tryClaimBotMentionMessage('msg-1')).toBe(true);
    expect(tryClaimBotMentionMessage('msg-1')).toBe(false);
    expect(tryClaimBotMentionMessage('msg-1')).toBe(false);
  });

  it('tryClaim against a pre-marked id returns false (signal-file then WS scenario)', () => {
    markBotMentionMessageHandled('msg-2');
    expect(tryClaimBotMentionMessage('msg-2')).toBe(false);
  });

  it('a subsequent isBotMentionMessageHandled sees a tryClaim-marked id', () => {
    expect(isBotMentionMessageHandled('msg-3')).toBe(false);
    expect(tryClaimBotMentionMessage('msg-3')).toBe(true);
    expect(isBotMentionMessageHandled('msg-3')).toBe(true);
  });

  it('different messageIds are independent', () => {
    expect(tryClaimBotMentionMessage('msg-a')).toBe(true);
    expect(tryClaimBotMentionMessage('msg-b')).toBe(true);
    expect(tryClaimBotMentionMessage('msg-a')).toBe(false);
    expect(tryClaimBotMentionMessage('msg-b')).toBe(false);
  });

  it('undefined messageId returns false and does not poison subsequent claims', () => {
    expect(tryClaimBotMentionMessage(undefined)).toBe(false);
    expect(tryClaimBotMentionMessage('msg-real')).toBe(true);
  });
});
