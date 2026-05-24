import type { BotState } from '../bot-registry.js';
import { listChatMemberOpenIds } from '../im/lark/client.js';
import { hasOwnerEntry } from '../setup/bot-config-editor.js';
import { logger } from '../utils/logger.js';

export async function resolveAllowedChatGroups(bot: BotState): Promise<void> {
  const chatIds = bot.config.allowedChatGroups ?? [];
  if (chatIds.length === 0) return;

  // 兜底手动编辑 bots.json 绕过 setup 校验的情况：配了 allowedChatGroups 却没 owner，
  // 群成员只拿到 canTalk，敏感操作对所有人关闭（含 owner）。setup 已拦，这里只补一条 warn。
  if (!hasOwnerEntry(bot.config.allowedUsers)) {
    logger.warn(
      `[${bot.config.larkAppId}] allowedChatGroups 已配置但 allowedUsers 无 owner（完整邮箱或 open_id）: ` +
      `群成员可对话，但 /restart、/close、/grant 等敏感操作将对所有人不可用。请在 allowedUsers 配置至少一个 owner。`,
    );
  }

  const resolved = new Set<string>();
  for (const chatId of chatIds) {
    try {
      const members = await listChatMemberOpenIds(bot.config.larkAppId, chatId);
      for (const openId of members) resolved.add(openId);
      logger.info(`[${bot.config.larkAppId}] Resolved allowedChatGroups ${chatId}: ${members.length} member(s)`);
    } catch (err: any) {
      logger.warn(`[${bot.config.larkAppId}] Failed to resolve allowedChatGroups ${chatId}: ${err?.message ?? err}`);
    }
  }
  bot.resolvedAllowedChatGroupUsers = [...resolved];
}
