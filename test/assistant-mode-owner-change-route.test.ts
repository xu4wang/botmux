/**
 * Assistant mode, owner change, through the REAL daemon route (handleThreadReply):
 * a message routed to a session that belongs to the chat's previous owner must be
 * refused BEFORE its attachments are downloaded — downloading first would persist
 * the new owner's file in the previous owner's bucket.
 *
 * Run: npx vitest run --project unit test/assistant-mode-owner-change-route.test.ts
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  // The dispatch-report secret lives in dirname(dataDir) and must sit in a
  // directory the current user owns: nest the data dir one level down so its
  // parent is this test's own directory, not the shared /tmp (owned by root
  // on CI runners, which run as a regular user).
  const ownRoot = `${process.env.TMPDIR ?? '/tmp'}/botmux-assistant-route-${process.pid}`;
  const dataDir = `${ownRoot}/data`;
  process.env.SESSION_DATA_DIR = dataDir;
  process.env.BOTS_CONFIG = `${dataDir}/bots.json`;
  delete process.env.BOTMUX_SESSION_ID;
  delete process.env.BOTMUX_LARK_APP_ID;
  let seq = 0;
  return {
    ownRoot,
    dataDir,
    runsDir: `${dataDir}/v3-runs`,
    replyMessage: vi.fn(async (..._args: any[]) => 'om_reply'),
    sendMessage: vi.fn(async (..._args: any[]) => 'om_sent'),
    getChatMode: vi.fn(async () => 'topic' as 'group' | 'topic' | 'p2p'),
    getChatNameAndMode: vi.fn(async () => ({ name: null, mode: 'topic' as const })),
    resolveSender: vi.fn(async (_appId: string, openId?: string, senderType?: string) => (
      openId ? { openId, type: senderType === 'app' || senderType === 'bot' ? 'bot' as const : 'user' as const } : undefined
    )),
    forkWorker: vi.fn((..._args: any[]) => undefined),
    sendWorkerInput: vi.fn((..._args: any[]) => true),
    downloadResources: vi.fn(async (..._args: any[]) => ({ attachments: [] as unknown[], needLogin: false })),
    createdSessions: [] as any[],
    createSession: vi.fn(function (chatId: string, rootMessageId: string, title: string, chatType?: 'group' | 'p2p') {
      const session = {
        sessionId: `sess-as-${++seq}`, chatId, rootMessageId, title, status: 'active' as const,
        createdAt: new Date().toISOString(), chatType,
      };
      mocks.createdSessions.push(session);
      return session;
    }),
    updateSession: vi.fn(),
  };
});

vi.mock('@larksuiteoapi/node-sdk', () => {
  class FakeClient { constructor(public opts: Record<string, unknown>) {} }
  return { Client: FakeClient };
});

vi.mock('node-pty', () => ({
  spawn: vi.fn(() => ({ onData: vi.fn(), onExit: vi.fn(), write: vi.fn(), resize: vi.fn(), kill: vi.fn() })),
}));

vi.mock('../src/im/lark/client.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/client.js');
  return {
    ...actual,
    replyMessage: mocks.replyMessage,
    sendMessage: mocks.sendMessage,
    getChatMode: mocks.getChatMode,
    getChatModeStrict: mocks.getChatMode,
    getChatNameAndMode: mocks.getChatNameAndMode,
    getChatInfo: vi.fn(async () => ({ userCount: 1, botCount: 2 })),
    listChatBotMembers: vi.fn(async () => []),
    resolveAllowedUsersWithMap: vi.fn(async (_appId: string, users: string[]) => ({ resolved: users, map: new Map() })),
    sendUserMessage: vi.fn(async () => 'om_dm'),
    updateMessage: vi.fn(async () => undefined),
    addReaction: vi.fn(async () => 'reaction'),
  };
});

const askMocks = vi.hoisted(() => ({
  pending: undefined as any,
  list: undefined as any[] | undefined,
  submitCustomReply: vi.fn(() => 'accepted'),
}));

vi.mock('../src/core/ask-broker.js', async () => {
  const actual = await vi.importActual<any>('../src/core/ask-broker.js');
  return {
    ...actual,
    listPendingAsksByAnchor: () => askMocks.list ?? (askMocks.pending ? [askMocks.pending] : []),
    findPendingAskByAnchor: () => askMocks.pending,
    submitCustomReply: (...args: any[]) => askMocks.submitCustomReply(...args),
  };
});

vi.mock('../src/services/session-store.js', async () => {
  const actual = await vi.importActual<any>('../src/services/session-store.js');
  return { ...actual, createSession: mocks.createSession, updateSession: mocks.updateSession };
});

vi.mock('../src/im/lark/identity-cache.js', async () => {
  const actual = await vi.importActual<any>('../src/im/lark/identity-cache.js');
  return { ...actual, resolveSender: (...args: any[]) => mocks.resolveSender(...args) };
});

vi.mock('../src/core/worker-pool.js', async () => {
  const actual = await vi.importActual<any>('../src/core/worker-pool.js');
  return {
    ...actual,
    forkWorker: (...args: any[]) => mocks.forkWorker(...args),
    sendWorkerInput: (...args: any[]) => mocks.sendWorkerInput(...args),
  };
});

vi.mock('../src/core/session-manager.js', async () => {
  const actual = await vi.importActual<any>('../src/core/session-manager.js');
  return { ...actual, downloadResources: (...args: any[]) => mocks.downloadResources(...args) };
});

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';

import { registerBot, getBot } from '../src/bot-registry.js';
import {
  __testOnly_activeSessions as activeSessions,
  __testOnly_handleThreadReply as handleThreadReply,
  __testOnly_handleNewTopic as handleNewTopic,
} from '../src/daemon.js';
import { sessionKey, type DaemonSession } from '../src/core/types.js';
import type { RoutingContext } from '../src/im/lark/event-dispatcher.js';
import { setAssistantOwner } from '../src/services/assistant-owner-store.js';

const APP = 'assistant_route_app';
const BOT_OPEN_ID = 'ou_assistant_route_bot';
const A = `ou_${'a'.repeat(32)}`;
const B = `ou_${'b'.repeat(32)}`;
const CHAT = 'oc_assistant_route_chat';
const ROOT = 'om_assistant_route_root';

function fileMessage(sender: string, messageId: string): any {
  return {
    sender: { sender_id: { open_id: sender }, sender_type: 'user' },
    message: {
      message_id: messageId,
      chat_id: CHAT,
      chat_type: 'group',
      message_type: 'file',
      root_id: ROOT,
      thread_id: 'omt_assistant_route',
      content: JSON.stringify({ file_key: 'file_v3_secret', file_name: 'secret.pdf' }),
      create_time: String(Date.now()),
    },
  };
}

function ctx(messageId: string): RoutingContext {
  return { chatId: CHAT, messageId, chatType: 'group', scope: 'thread', anchor: ROOT, larkAppId: APP } as RoutingContext;
}

function seedOwnedSession(owner: string): DaemonSession {
  const session: any = {
    sessionId: 'sess-assistant-owned', chatId: CHAT, rootMessageId: ROOT, title: 'chat', status: 'active',
    createdAt: new Date().toISOString(), chatType: 'group', larkAppId: APP, ownerOpenId: owner, scope: 'thread',
    assistantOwnerOpenId: owner, sandbox: 'oncall', sandboxWithholdBotSecret: true, workingDir: mocks.dataDir,
  };
  const ds = {
    session, worker: { killed: false, send: vi.fn() }, workerPort: null, workerToken: null, larkAppId: APP, chatId: CHAT,
    chatType: 'group', scope: 'thread', spawnedAt: Date.now(), cliVersion: '1.0.0', lastMessageAt: Date.now(),
    hasHistory: true, workingDir: mocks.dataDir,
  } as unknown as DaemonSession;
  activeSessions.set(sessionKey(ROOT, APP), ds);
  return ds;
}

beforeEach(() => {
  vi.clearAllMocks();
  mkdirSync(mocks.dataDir, { recursive: true });
  writeFileSync(process.env.BOTS_CONFIG!, JSON.stringify([]));
  activeSessions.clear();
  mocks.getChatMode.mockResolvedValue('topic');
  mocks.sendWorkerInput.mockReturnValue(true);
  registerBot({
    larkAppId: APP, larkAppSecret: 'secret', cliId: 'claude-code', allowedUsers: [A, B],
    sandbox: 'oncall', assistantMode: true,
  } as any);
  const bot = getBot(APP);
  bot.resolvedAllowedUsers = [A, B];
  bot.botOpenId = BOT_OPEN_ID;
  bot.botName = 'Assistant';
});

afterAll(() => {
  rmSync(mocks.ownRoot, { recursive: true, force: true });
});

describe('assistant mode: owner changed while the previous owner\'s session is still routed to', () => {
  it('refuses the message before downloading its attachment, and never hands it to the old worker', async () => {
    seedOwnedSession(A);
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'claimed');
    await handleThreadReply(fileMessage(B, 'om_assistant_b_file'), ctx('om_assistant_b_file'));

    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('control: while the session still belongs to the current owner the attachment lands in that owner\'s bucket', async () => {
    seedOwnedSession(A);
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'claimed');
    await handleThreadReply(fileMessage(A, 'om_assistant_a_file'), ctx('om_assistant_a_file'));

    expect(mocks.downloadResources).toHaveBeenCalledTimes(1);
    expect(mocks.downloadResources.mock.calls[0]![4]).toBe(A);
  });

  it('no session yet: if the owner changes while the attachment downloads, no session is created for the new owner', async () => {
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'claimed');
    mocks.downloadResources.mockImplementationOnce(async (..._args: any[]) => {
      setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'admin');
      return { attachments: [], needLogin: false };
    });
    await handleThreadReply(fileMessage(B, 'om_assistant_b_late'), ctx('om_assistant_b_late'));

    expect(mocks.downloadResources.mock.calls[0]![4]).toBe(B);
    expect(mocks.createdSessions).toEqual([]);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it('new topic: if the owner changes while the attachment downloads, no session is created for the new owner', async () => {
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'claimed');
    mocks.downloadResources.mockImplementationOnce(async (..._args: any[]) => {
      setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'admin');
      return { attachments: [], needLogin: false };
    });
    const event = fileMessage(B, 'om_assistant_b_topic');
    delete event.message.root_id; delete event.message.thread_id;
    await handleNewTopic(event, { chatId: CHAT, messageId: 'om_assistant_b_topic', chatType: 'group', scope: 'thread', anchor: 'om_assistant_b_topic', larkAppId: APP } as RoutingContext);

    expect(mocks.downloadResources).toHaveBeenCalledTimes(1);
    expect(mocks.downloadResources.mock.calls[0]![4]).toBe(B);
    expect(mocks.createdSessions).toEqual([]);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('assistant mode turned off: a still-running owner session keeps receiving attachments in its owner\'s bucket', async () => {
    seedOwnedSession(A);
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'claimed');
    getBot(APP).config.assistantMode = false;
    await handleThreadReply(fileMessage(A, 'om_assistant_off_file'), ctx('om_assistant_off_file'));

    expect(mocks.downloadResources).toHaveBeenCalledTimes(1);
    expect(mocks.downloadResources.mock.calls[0]![4]).toBe(A);
  });

  it('re-entry carrying the preparation owner: refused once the chat belongs to someone else', async () => {
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'admin');
    await handleThreadReply(fileMessage(B, 'om_assistant_reentry'), { ...ctx('om_assistant_reentry'), assistantPreparedOwnerOpenId: B });

    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toEqual([]);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
  });

  it.each([
    ['an ask left by the previous owner\'s retired session is not settled with the new owner\'s text', 'sess-old-owner-a', 0],
    ['control: the current owner\'s own pending ask is settled', 'sess-assistant-owned', 1],
  ] as const)('%s', async (_label, askSessionId, settled) => {
    seedOwnedSession(B);
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'claimed');
    askMocks.pending = { askId: 'ask_1', sessionId: askSessionId, larkAppId: APP, chatId: CHAT, originKind: 'host_explicit' };
    try {
      const event = fileMessage(B, 'om_assistant_ask_text');
      event.message.message_type = 'text';
      event.message.content = JSON.stringify({ text: 'my private answer' });
      await handleThreadReply(event, ctx('om_assistant_ask_text'));
      expect(askMocks.submitCustomReply).toHaveBeenCalledTimes(settled);
    } finally {
      askMocks.pending = undefined;
    }
  });

  it('a retained ask from the previous owner does not shadow the current owner\'s own ask', async () => {
    seedOwnedSession(B);
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'claimed');
    askMocks.list = [
      { askId: 'ask_old', sessionId: 'sess-old-owner-a', larkAppId: APP, chatId: CHAT, originKind: 'host_explicit' },
      { askId: 'ask_new', sessionId: 'sess-assistant-owned', larkAppId: APP, chatId: CHAT, originKind: 'host_explicit' },
    ];
    try {
      const event = fileMessage(B, 'om_assistant_ask_two');
      event.message.message_type = 'text';
      event.message.content = JSON.stringify({ text: 'answer for B' });
      await handleThreadReply(event, ctx('om_assistant_ask_two'));
      expect(askMocks.submitCustomReply).toHaveBeenCalledTimes(1);
      expect((askMocks.submitCustomReply.mock.calls[0] as any[])[0].askId).toBe('ask_new');
    } finally {
      askMocks.list = undefined;
    }
  });

  it('a message deferred behind a cascade and replayed after the owner changed is refused', async () => {
    seedOwnedSession(A);
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'admin');
    const event = fileMessage(B, 'om_assistant_cascade_replay');
    await handleThreadReply(event, { ...ctx('om_assistant_cascade_replay'), cascadeBodyReentry: true, assistantPreparedOwnerOpenId: B } as RoutingContext);

    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('stamps the arrival owner on the routing context the first time a message is handled', async () => {
    seedOwnedSession(A);
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'claimed');
    const routing = ctx('om_assistant_stamp');
    await handleThreadReply(fileMessage(A, 'om_assistant_stamp'), routing);
    expect(routing.assistantPreparedOwnerOpenId).toBe(A);
  });

  it('new topic: owner changed after the message arrived (before ownership is resolved) creates no session for the new owner', async () => {
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'admin');
    const event = fileMessage(B, 'om_assistant_topic_stamp');
    delete event.message.root_id; delete event.message.thread_id;
    await handleNewTopic(event, { chatId: CHAT, messageId: 'om_assistant_topic_stamp', chatType: 'group', scope: 'thread', anchor: 'om_assistant_topic_stamp', larkAppId: APP, assistantPreparedOwnerOpenId: B } as RoutingContext);

    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toEqual([]);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('new topic: a slash command that arrived under the previous owner is not executed for the new owner', async () => {
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'admin');
    const event = fileMessage(A, 'om_assistant_topic_slash');
    delete event.message.root_id; delete event.message.thread_id;
    event.message.message_type = 'text';
    event.message.content = JSON.stringify({ text: '/schedule every 1h summarize my private notes' });
    await handleNewTopic(event, { chatId: CHAT, messageId: 'om_assistant_topic_slash', chatType: 'group', scope: 'thread', anchor: 'om_assistant_topic_slash', larkAppId: APP, assistantPreparedOwnerOpenId: A } as RoutingContext);

    expect(mocks.createdSessions).toEqual([]);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('a message that queued under the previous owner keeps the owner stamped when the event arrived', async () => {
    seedOwnedSession(A);
    setAssistantOwner(mocks.dataDir, APP, CHAT, A, 'admin');
    const event = fileMessage(B, 'om_assistant_queued');
    event.__botmuxAssistantArrivalOwner = B; // stamped by the dispatcher when the event arrived
    await handleThreadReply(event, ctx('om_assistant_queued'));

    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(mocks.sendWorkerInput).not.toHaveBeenCalled();
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });

  it('paired messages: a buffered seed that arrived under the previous owner is not merged into the new owner\'s turn', async () => {
    setAssistantOwner(mocks.dataDir, APP, CHAT, B, 'admin');
    const seed = fileMessage(A, 'om_assistant_seed');
    delete seed.message.root_id; delete seed.message.thread_id;
    seed.__botmuxAssistantArrivalOwner = A;
    const followUp = fileMessage(B, 'om_assistant_followup');
    delete followUp.message.root_id; delete followUp.message.thread_id;
    followUp.message.message_type = 'text';
    followUp.message.content = JSON.stringify({ text: 'continue' });
    followUp.__botmuxAssistantArrivalOwner = B;
    await handleNewTopic(followUp, { chatId: CHAT, messageId: 'om_assistant_followup', chatType: 'group', scope: 'thread', anchor: 'om_assistant_followup', larkAppId: APP, forwardSeedData: seed } as RoutingContext);

    expect(mocks.downloadResources).not.toHaveBeenCalled();
    expect(mocks.createdSessions).toEqual([]);
    expect(mocks.forkWorker).not.toHaveBeenCalled();
  });
});
