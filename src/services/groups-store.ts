/**
 * Thin wrappers over Feishu IM v1 chat APIs for the dashboard's groups board.
 *
 * Phase B (Web Dashboard) — Task 24. These wrappers are stateless; they reuse
 * the per-bot Lark SDK client created by `bot-registry`.
 *
 * The "proxy bot" pattern in `addBotToChat`: Feishu requires the inviter to
 * already be a member of the chat, so the dashboard picks an existing-member
 * bot to do the invite. This wrapper just exposes the underlying call —
 * proxy selection happens at the route layer.
 */
import { getBotClient } from '../bot-registry.js';

export interface ChatBrief {
  chatId: string;
  name?: string;
  description?: string;
  chatMode?: string;
  ownerId?: string;
}

/**
 * List chats the given bot is a member of, draining pagination internally.
 * Uses /open-apis/im/v1/chats.
 */
export async function listChats(larkAppId: string): Promise<ChatBrief[]> {
  const client = getBotClient(larkAppId);
  const out: ChatBrief[] = [];
  let pageToken: string | undefined;
  do {
    const res: any = await (client as any).im.v1.chat.list({
      params: {
        page_size: 100,
        user_id_type: 'open_id',
        ...(pageToken ? { page_token: pageToken } : {}),
      },
    });
    if (res.code !== 0 && res.code !== undefined) {
      throw new Error(`Failed to list chats: ${res.msg} (code: ${res.code})`);
    }
    for (const c of res.data?.items ?? []) {
      out.push({
        chatId: c.chat_id,
        name: c.name,
        description: c.description,
        chatMode: c.chat_mode,
        ownerId: c.owner_id,
      });
    }
    pageToken = res.data?.has_more ? res.data?.page_token : undefined;
  } while (pageToken);
  return out;
}

/**
 * Check whether the given bot is a member of the given chat.
 * Uses /open-apis/im/v1/chats/:chat_id/members/is_in_chat — the bot's own
 * access token implicitly identifies the bot being checked.
 *
 * Errors (chat not found, no permission, etc.) are swallowed and treated as
 * "not in chat" so callers can use this as a simple boolean predicate.
 */
export async function isInChat(larkAppId: string, chatId: string): Promise<boolean> {
  const client = getBotClient(larkAppId);
  try {
    const res: any = await (client as any).im.v1.chatMembers.isInChat({
      path: { chat_id: chatId },
    });
    if (res.code !== 0 && res.code !== undefined) return false;
    return !!res.data?.is_in_chat;
  } catch {
    return false;
  }
}

/**
 * Add bot apps to a chat using a "proxy" bot that's already a member.
 * Uses /open-apis/im/v1/chats/:chat_id/members with member_id_type=app_id.
 * Returns per-id result derived from the API's invalid_id_list.
 *
 * On total failure (network error, non-zero code) every id reports the same
 * error so the caller can present a uniform per-id status.
 */
export async function addBotToChat(
  proxyLarkAppId: string,
  chatId: string,
  targetLarkAppIds: string[],
): Promise<{ id: string; ok: boolean; error?: string }[]> {
  if (targetLarkAppIds.length === 0) return [];
  const client = getBotClient(proxyLarkAppId);
  const out: { id: string; ok: boolean; error?: string }[] = [];
  try {
    const res: any = await (client as any).im.v1.chatMembers.create({
      path: { chat_id: chatId },
      params: { member_id_type: 'app_id' },
      data: { id_list: targetLarkAppIds },
    });
    if (res.code !== 0 && res.code !== undefined) {
      const errMsg = `${res.msg ?? 'unknown'} (code: ${res.code})`;
      for (const id of targetLarkAppIds) out.push({ id, ok: false, error: errMsg });
      return out;
    }
    const invalid = new Set<string>(res.data?.invalid_id_list ?? []);
    for (const id of targetLarkAppIds) {
      out.push(invalid.has(id) ? { id, ok: false, error: 'invalid_id' } : { id, ok: true });
    }
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    for (const id of targetLarkAppIds) out.push({ id, ok: false, error: msg });
  }
  return out;
}
