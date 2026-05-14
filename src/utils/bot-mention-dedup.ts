/**
 * Cross-path dedup for bot-to-bot @mentions.
 *
 * Two routes can deliver the same `botmux send --mention <peer>` to a target
 * daemon:
 *   1. Lark WSClient → event-dispatcher → handleThreadReply
 *   2. signal-file watcher → processBotMentionSignal
 *
 * Whichever fires first records the inbound message_id here; the other side
 * checks before forwarding to the worker so we never enqueue the same turn
 * twice. Keyed by inbound message_id (not session/anchor) so it is robust to
 * reordering and to stale `lastMessageAt` from prior unrelated turns.
 *
 * In-memory only (one instance per daemon process). Entries expire after
 * `TTL_MS` to keep the map bounded; 30s is well past any realistic gap
 * between the two paths.
 */

const TTL_MS = 30_000;

const seen = new Map<string, number>(); // messageId → expiresAt (epoch ms)

/** Mark this messageId as already routed to the worker by one of the two
 *  paths. Calling twice for the same id is a no-op. */
export function markBotMentionMessageHandled(messageId: string | undefined): void {
  if (!messageId) return;
  gc();
  seen.set(messageId, Date.now() + TTL_MS);
}

/** Did we already route this messageId? Returns true if the other path got
 *  there first within the TTL window. */
export function isBotMentionMessageHandled(messageId: string | undefined): boolean {
  if (!messageId) return false;
  const expiresAt = seen.get(messageId);
  if (expiresAt === undefined) return false;
  if (expiresAt < Date.now()) {
    seen.delete(messageId);
    return false;
  }
  return true;
}

/** Atomic check-and-set: claim this messageId for processing. Returns `true`
 *  iff the caller is the first to claim within the TTL window — only that
 *  caller may enqueue the message.
 *
 *  Use this instead of `isBotMentionMessageHandled` + `markBotMentionMessageHandled`
 *  whenever there is an `await` between the two: JS is single-threaded but the
 *  yield lets the OTHER dedup path slip in, pass its own check, mark, and
 *  enqueue — we'd then re-mark (no-op) and enqueue a second time. `tryClaim`
 *  collapses both halves into one synchronous step so the two paths can't both
 *  win, regardless of who runs first. */
export function tryClaimBotMentionMessage(messageId: string | undefined): boolean {
  if (!messageId) return false;
  if (isBotMentionMessageHandled(messageId)) return false;
  markBotMentionMessageHandled(messageId);
  return true;
}

/** Test seam — drop everything. */
export function _resetForTest(): void {
  seen.clear();
}

function gc(): void {
  // Cheap incremental GC: only sweep when we cross a small threshold.
  if (seen.size < 64) return;
  const now = Date.now();
  for (const [k, v] of seen) {
    if (v < now) seen.delete(k);
  }
}
