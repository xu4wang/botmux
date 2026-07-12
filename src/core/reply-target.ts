import type { DaemonSession } from './types.js';
import type { Session } from '../types.js';

export type SessionReplyTarget =
  | { mode: 'plain'; chatId: string }
  | { mode: 'thread'; rootMessageId: string }
  | { mode: 'quote'; rootMessageId: string };

export function resolveSessionReplyTarget(
  ds: Pick<DaemonSession, 'scope' | 'chatId' | 'session' | 'currentReplyTarget'>,
  turnId?: string,
): SessionReplyTarget {
  const target = ds.currentReplyTarget ?? ds.session.currentReplyTarget;
  if (ds.scope === 'chat') {
    if (target?.rootMessageId && !!turnId && target.turnId === turnId) {
      return target.quoteOnly
        ? { mode: 'quote', rootMessageId: target.rootMessageId }
        : { mode: 'thread', rootMessageId: target.rootMessageId };
    }
    return { mode: 'plain', chatId: ds.chatId };
  }
  return { mode: 'thread', rootMessageId: ds.session.rootMessageId };
}

export function resolveSendTarget(opts: {
  into?: string;
  topLevel: boolean;
  chatScope: boolean;
  chatId: string;
  rootMessageId: string;
  replyTargetRootId?: string;
  replyTargetTurnId?: string;
  replyTargetQuoteOnly?: boolean;
  currentTurnId?: string;
}): SessionReplyTarget {
  if (opts.into) return { mode: 'thread', rootMessageId: opts.into };
  if (opts.topLevel) return { mode: 'plain', chatId: opts.chatId };
  if (opts.chatScope) {
    if (opts.replyTargetRootId && opts.replyTargetTurnId && opts.replyTargetTurnId === opts.currentTurnId) {
      return opts.replyTargetQuoteOnly
        ? { mode: 'quote', rootMessageId: opts.replyTargetRootId }
        : { mode: 'thread', rootMessageId: opts.replyTargetRootId };
    }
    return { mode: 'plain', chatId: opts.chatId };
  }
  return { mode: 'thread', rootMessageId: opts.rootMessageId };
}

export function beginReplyTargetTurn(
  ds: DaemonSession,
  replyRootId: string | undefined,
  turnId: string,
  nowIso = new Date().toISOString(),
  opts?: { quoteOnly?: boolean },
): void {
  if (ds.scope !== 'chat') return;
  if (replyRootId) {
    const aliases = { ...(ds.replyThreadAliases ?? ds.session.replyThreadAliases ?? {}) };
    aliases[replyRootId] = {
      createdAt: aliases[replyRootId]?.createdAt ?? nowIso,
      lastUsedAt: nowIso,
    };
    const target = { rootMessageId: replyRootId, turnId, updatedAt: nowIso, quoteOnly: opts?.quoteOnly };
    ds.replyThreadAliases = aliases;
    ds.currentReplyTarget = target;
    ds.session.replyThreadAliases = aliases;
    ds.session.currentReplyTarget = target;
    return;
  }
  ds.currentReplyTarget = undefined;
  ds.session.currentReplyTarget = undefined;
}

/**
 * Effective turnId for a daemon-side message. Callers that know their turn
 * (worker final_output, placeholder cards) pass it explicitly and the
 * stale-turn gate in resolveSessionReplyTarget stays authoritative. Callers
 * with NO turn context of their own (the worker's first streaming card,
 * crash notices) fall back to the session's current reply-target turn — in a
 * shared fold-back topic they then follow the conversation into the thread
 * instead of leaking to the chat top level.
 */
export function fallbackTurnId(
  ds: Pick<DaemonSession, 'session' | 'currentReplyTarget'>,
  turnId: string | undefined,
): string | undefined {
  return turnId ?? (ds.currentReplyTarget ?? ds.session.currentReplyTarget)?.turnId;
}

export function syncReplyTargetState(ds: DaemonSession, s?: Session): void {
  const source = s ?? ds.session;
  ds.replyThreadAliases = source.replyThreadAliases;
  ds.currentReplyTarget = source.currentReplyTarget;
}
