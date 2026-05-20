/**
 * 群内授权元命令：`@bot /grant @user`、`@bot /revoke @user`。
 * 在 dispatcher 路由/spawn 之前拦截，仅 owner 可用。
 * 与 /introduce 不同：必须确认本 bot 被 @（多 bot 群防重复处理），
 * 且解析 target 时排除 bot 自身。
 */
import { getOwnerOpenId, getBotOpenId } from '../../bot-registry.js';
import { isBotMentioned, extractMessageTextForRouting } from './event-dispatcher.js';
import { buildGrantCard } from './card-builder.js';
import { openPending } from './grant-pending.js';
import { revokeGrant } from '../../services/grant-store.js';
import { replyMessage } from './client.js';
import { localeForBot, t } from '../../i18n/index.js';
import { logger } from '../../utils/logger.js';

/** 从 mention 列表取第一个非本 bot 的人类对象。 */
export function parseGrantTarget(message: any, botOpenId: string | undefined): { openId: string; name: string } | undefined {
  const m = (message?.mentions ?? []).find((x: any) => x?.id?.open_id && x.id.open_id !== botOpenId);
  return m ? { openId: m.id.open_id, name: m.name ?? m.id.open_id } : undefined;
}

/** 返回 true 表示已拦截（不再进入路由/spawn）。 */
export async function tryHandleGrantCommand(
  larkAppId: string, message: any, senderOpenId: string | undefined,
): Promise<boolean> {
  const text = (extractMessageTextForRouting(message) ?? '').trim();
  const isGrant = /^\/grant(\s|$)/i.test(text);
  const isRevoke = /^\/revoke(\s|$)/i.test(text);
  if (!isGrant && !isRevoke) return false;

  // 多 bot 群：必须明确 @ 当前 bot 才由本 daemon 处理；否则吞掉（不喂 CLI）。
  if (!isBotMentioned(larkAppId, message, senderOpenId)) return true;

  const loc = localeForBot(larkAppId);
  const messageId = message.message_id;
  const chatId = message.chat_id;

  // owner 强闸门
  const owner = getOwnerOpenId(larkAppId);
  if (!senderOpenId || senderOpenId !== owner) {
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: t(isGrant ? 'cmd.grant.owner_only' : 'cmd.revoke.owner_only', undefined, loc) }))
      .catch(err => logger.debug(`grant owner_only reply failed: ${err}`));
    return true;
  }

  const target = parseGrantTarget(message, getBotOpenId(larkAppId));
  if (!target) {
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: t(isGrant ? 'cmd.grant.usage' : 'cmd.revoke.usage', undefined, loc) }))
      .catch(err => logger.debug(`grant usage reply failed: ${err}`));
    return true;
  }

  if (isRevoke) {
    const r = await revokeGrant(larkAppId, chatId, target.openId);
    let txt: string;
    if (!r.ok) {
      txt = r.reason === 'would_open_bot'
        ? t('cmd.revoke.would_open', undefined, loc)
        : t('cmd.revoke.failed', { reason: r.reason }, loc);
    } else {
      const scope = `${r.removed.chat ? t('cmd.revoke.scope_chat', undefined, loc) : ''}${r.removed.global ? t('cmd.revoke.scope_global', undefined, loc) : ''}`.trim()
        || t('cmd.revoke.scope_none', undefined, loc);
      txt = t('cmd.revoke.done', { name: target.name, scope }, loc);
    }
    await replyMessage(larkAppId, messageId, JSON.stringify({ text: txt }))
      .catch(err => logger.debug(`revoke reply failed: ${err}`));
    return true;
  }

  // /grant → 弹卡（owner 主动态），owner 点范围按钮完成授权。
  const nonce = openPending(larkAppId, chatId, target.openId);
  const card = buildGrantCard(
    { ownerOpenId: owner!, requesterOpenId: target.openId, requesterName: target.name, chatId, nonce, mode: 'owner' },
    loc,
  );
  await replyMessage(larkAppId, messageId, card, 'interactive')
    .catch(err => logger.debug(`grant card reply failed: ${err}`));
  logger.info(`[grant:${larkAppId}] owner /grant card for ${target.openId} in ${chatId}`);
  return true;
}
