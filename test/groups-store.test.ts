/**
 * Unit tests for groups-store wrappers (Lark im/v1 chat APIs).
 *
 * Run:  pnpm vitest run test/groups-store.test.ts
 */
import { describe, it, expect, vi } from 'vitest';

// Mock bot-registry's getBotClient — that's where groups-store imports from.
vi.mock('../src/bot-registry.js', () => ({
  getBotClient: vi.fn().mockImplementation(() => ({
    im: {
      v1: {
        chat: {
          list: vi.fn().mockResolvedValue({
            code: 0,
            data: {
              items: [
                {
                  chat_id: 'c1',
                  name: 'one',
                  description: 'first chat',
                  chat_mode: 'group',
                  owner_id: 'ou_owner',
                },
              ],
              has_more: false,
            },
          }),
        },
        chatMembers: {
          isInChat: vi.fn().mockResolvedValue({ code: 0, data: { is_in_chat: true } }),
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { invalid_id_list: ['cli_X'] },
          }),
        },
      },
    },
  })),
}));

import { listChats, isInChat, addBotToChat } from '../src/services/groups-store.js';

describe('groups-store wrappers', () => {
  it('listChats returns ChatBrief array', async () => {
    const out = await listChats('appA');
    expect(out).toHaveLength(1);
    expect(out[0].chatId).toBe('c1');
    expect(out[0].name).toBe('one');
    expect(out[0].description).toBe('first chat');
    expect(out[0].chatMode).toBe('group');
    expect(out[0].ownerId).toBe('ou_owner');
  });

  it('isInChat returns boolean', async () => {
    expect(await isInChat('appA', 'c1')).toBe(true);
  });

  it('addBotToChat marks invalid_id_list as failed and rest as ok', async () => {
    const r = await addBotToChat('appA', 'c1', ['cli_Y', 'cli_X']);
    expect(r.find(x => x.id === 'cli_Y')!.ok).toBe(true);
    expect(r.find(x => x.id === 'cli_X')!.ok).toBe(false);
    expect(r.find(x => x.id === 'cli_X')!.error).toBe('invalid_id');
  });

  it('addBotToChat with empty list returns empty', async () => {
    expect(await addBotToChat('appA', 'c1', [])).toEqual([]);
  });
});
