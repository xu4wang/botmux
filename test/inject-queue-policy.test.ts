/**
 * Worker inject-queue policy — pins the barrier-vs-user-message ordering rule
 * shared by both drain paths:
 *
 *  - `markPromptReady()` (idle path): decides whether to run
 *    `flushPendingInjections()` before `flushPending()`.
 *  - `flushPending()` (type-ahead path): type-ahead-capable adapters (Claude
 *    family) call `flushPending()` directly from `sendToPty()` even while the
 *    CLI is BUSY, bypassing `markPromptReady()` entirely — so it needs its
 *    own guard against writing a user message before a queued `/cd` (barrier)
 *    injection has drained. Without this guard the message lands in the CLI
 *    while it's still sitting in the OLD cwd (the bug this test pins).
 *
 * Run: pnpm vitest run test/inject-queue-policy.test.ts
 */
import { describe, it, expect } from 'vitest';
import {
  shouldDeferUserFlush,
  shouldFlushInjectionsFirst,
  type PendingInjection,
} from '../src/core/inject-queue-policy.js';

const plain = (command: string): PendingInjection => ({ command, barrier: false });
const barrier = (command: string): PendingInjection => ({ command, barrier: true });

describe('shouldDeferUserFlush', () => {
  it('does not defer on an empty queue', () => {
    expect(shouldDeferUserFlush([])).toBe(false);
  });

  it('does not defer when only plain (non-barrier) injections are queued', () => {
    expect(shouldDeferUserFlush([plain('/effort ultracode'), plain('/model opus')])).toBe(false);
  });

  it('defers when a single barrier injection is queued', () => {
    expect(shouldDeferUserFlush([barrier('/cd ~/project-b')])).toBe(true);
  });

  it('defers when the barrier is at the TAIL of the queue (behind plain injections)', () => {
    expect(shouldDeferUserFlush([plain('/effort ultracode'), barrier('/cd ~/project-b')])).toBe(true);
  });

  it('defers when the barrier is at the HEAD of the queue (ahead of plain injections)', () => {
    expect(shouldDeferUserFlush([barrier('/cd ~/project-b'), plain('/effort ultracode')])).toBe(true);
  });

  it('defers when multiple barriers are queued', () => {
    expect(shouldDeferUserFlush([barrier('/cd ~/a'), barrier('/cd ~/b')])).toBe(true);
  });
});

describe('shouldFlushInjectionsFirst', () => {
  it('does not prioritize injections on an empty queue', () => {
    expect(shouldFlushInjectionsFirst([])).toBe(false);
  });

  it('does not prioritize injections when only plain injections are queued', () => {
    expect(shouldFlushInjectionsFirst([plain('/effort ultracode')])).toBe(false);
  });

  it('prioritizes injections when a single barrier injection is queued', () => {
    expect(shouldFlushInjectionsFirst([barrier('/cd ~/project-b')])).toBe(true);
  });

  it('prioritizes injections when the barrier is at the tail of the queue', () => {
    expect(shouldFlushInjectionsFirst([plain('/effort ultracode'), barrier('/cd ~/project-b')])).toBe(true);
  });

  it('prioritizes injections when the barrier is at the head of the queue', () => {
    expect(shouldFlushInjectionsFirst([barrier('/cd ~/project-b'), plain('/effort ultracode')])).toBe(true);
  });

  it('prioritizes injections when multiple barriers are queued', () => {
    expect(shouldFlushInjectionsFirst([barrier('/cd ~/a'), barrier('/cd ~/b')])).toBe(true);
  });
});
