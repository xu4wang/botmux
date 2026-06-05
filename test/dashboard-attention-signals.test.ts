// test/dashboard-attention-signals.test.ts
//
// Attention signals for the dashboard sessions board (needs-you column):
//   - composeRowFromActive carries pendingRepo / tuiPromptActive
//   - publishAttentionPatch emits a session.update derived from live state
//   - announcePendingRepoSession announces card-waiting sessions (which have
//     no worker yet, so the normal spawn-time announce never fires) and
//     no-ops for non-pending sessions
import { describe, it, expect, beforeEach } from 'vitest';
import { composeRowFromActive } from '../src/core/dashboard-rows.js';
import { publishAttentionPatch, announcePendingRepoSession } from '../src/core/session-activity.js';
import { dashboardEventBus, type DashboardEvent } from '../src/core/dashboard-events.js';
import type { DaemonSession } from '../src/core/types.js';

function makeDs(overrides: Partial<DaemonSession> = {}): DaemonSession {
  return {
    session: {
      sessionId: 'sess-1',
      chatId: 'oc_chat',
      rootMessageId: 'om_root',
      title: 't',
      status: 'active',
      createdAt: new Date(1000).toISOString(),
    },
    worker: null,
    workerPort: null,
    workerToken: null,
    larkAppId: 'cli_app',
    chatId: 'oc_chat',
    chatType: 'group',
    scope: 'thread',
    spawnedAt: 1000,
    cliVersion: 'test',
    lastMessageAt: 1000,
    hasHistory: false,
    ...overrides,
  } as DaemonSession;
}

function collectEvents(): DashboardEvent[] {
  const seen: DashboardEvent[] = [];
  const off = dashboardEventBus.subscribe(e => seen.push(e));
  // vitest runs this file in one process — detach after each test via closure
  collectEvents.off = off;
  return seen;
}
collectEvents.off = () => {};

describe('attention signals', () => {
  beforeEach(() => {
    collectEvents.off();
  });

  it('composeRowFromActive exposes pendingRepo and tuiPromptActive', () => {
    const row = composeRowFromActive(makeDs({ pendingRepo: true, tuiPromptCardId: 'om_card' }));
    expect(row.pendingRepo).toBe(true);
    expect(row.tuiPromptActive).toBe(true);

    const quiet = composeRowFromActive(makeDs());
    expect(quiet.pendingRepo).toBe(false);
    expect(quiet.tuiPromptActive).toBe(false);
  });

  it('composeRowFromActive carries the session scope (locate vs open-chat)', () => {
    const chatScoped = makeDs();
    chatScoped.session.scope = 'chat';
    expect(composeRowFromActive(chatScoped).scope).toBe('chat');

    const threadScoped = makeDs();
    threadScoped.session.scope = 'thread';
    expect(composeRowFromActive(threadScoped).scope).toBe('thread');

    // legacy sessions persisted before the scope field existed
    expect(composeRowFromActive(makeDs()).scope).toBeUndefined();
  });

  it('publishAttentionPatch emits session.update derived from session state', () => {
    const seen = collectEvents();
    publishAttentionPatch(makeDs({ tuiPromptCardId: 'om_card' }));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      type: 'session.update',
      body: {
        sessionId: 'sess-1',
        patch: { pendingRepo: false, tuiPromptActive: true },
      },
    });
  });

  it('publishAttentionPatch reflects cleared signals (idempotent re-derive)', () => {
    const seen = collectEvents();
    const ds = makeDs({ pendingRepo: true });
    publishAttentionPatch(ds);
    ds.pendingRepo = false;
    publishAttentionPatch(ds);
    expect(seen.map(e => (e as any).body.patch.pendingRepo)).toEqual([true, false]);
  });

  it('announcePendingRepoSession publishes a full session.spawned row when pending', () => {
    const seen = collectEvents();
    announcePendingRepoSession(makeDs({ pendingRepo: true }));
    expect(seen).toHaveLength(1);
    expect(seen[0].type).toBe('session.spawned');
    const row = (seen[0] as any).body.session;
    expect(row.sessionId).toBe('sess-1');
    expect(row.pendingRepo).toBe(true);
    expect(row.status).toBe('starting'); // no screen yet → starting
  });

  it('announcePendingRepoSession is a no-op when the session is not pending', () => {
    const seen = collectEvents();
    announcePendingRepoSession(makeDs({ pendingRepo: false }));
    announcePendingRepoSession(makeDs());
    expect(seen).toHaveLength(0);
  });
});
