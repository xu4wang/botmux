/**
 * Per-chat persistent store of bot open_ids observed via the `/introduce`
 * protocol (and reserved for future passive-observation sources).
 *
 * Why per-chat (one file per chatId, not per app):
 * - Path-level isolation: lookups physically cannot leak entries from other
 *   chats. Avoids the "remembered to filter by chatId" foot-gun.
 * - Cross-daemon sharing: when multiple botmux daemons run on the same host,
 *   they all read/write the same `observed-bots-<chatId>.json`, so a /introduce
 *   from any bot benefits the others' lookups too.
 *
 * Atomic writes via tmp + rename — same pattern as chat-first-seen-store.
 * Multi-daemon concurrent writes converge: /introduce delivers identical
 * mentions[] to every receiving bot, so all racing writers want the same
 * end state.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export type ObservedBotSource = 'introduce';

export interface ObservedBot {
  openId: string;
  name: string;
  source: ObservedBotSource;
  firstSeenAt: number;
  lastSeenAt: number;
}

type FileEntry = { name: string; source: ObservedBotSource; firstSeenAt: number; lastSeenAt: number };
type FileShape = Record<string, FileEntry>;

function filePath(dataDir: string, chatId: string): string {
  return join(dataDir, `observed-bots-${chatId}.json`);
}

function readFile(dataDir: string, chatId: string): FileShape {
  const fp = filePath(dataDir, chatId);
  if (!existsSync(fp)) return {};
  try {
    const parsed = JSON.parse(readFileSync(fp, 'utf-8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as FileShape;
  } catch { /* corrupt — fall through */ }
  return {};
}

function writeFileAtomic(dataDir: string, chatId: string, data: FileShape): void {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
  const fp = filePath(dataDir, chatId);
  const tmp = fp + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  renameSync(tmp, fp);
}

/**
 * Merge a batch of (openId, name) pairs into the chat's observed-bots file.
 *
 * - Existing openIds: keep firstSeenAt, bump lastSeenAt, refresh name.
 * - New openIds: firstSeenAt = lastSeenAt = now.
 * - Entries with empty openId or empty name are silently skipped — callers
 *   pass through whatever Lark gave them, and we never want a half-known
 *   entry polluting the store.
 * - Empty input or all-filtered input is a no-op (no file write).
 */
export function recordObservedBots(
  dataDir: string,
  chatId: string,
  bots: ReadonlyArray<{ openId: string; name: string }>,
  source: ObservedBotSource = 'introduce',
  now: number = Date.now(),
): void {
  const valid = bots.filter(b => b.openId && b.name);
  if (valid.length === 0) return;

  const data = readFile(dataDir, chatId);
  for (const b of valid) {
    const prior = data[b.openId];
    if (prior) {
      data[b.openId] = { ...prior, name: b.name, lastSeenAt: now };
    } else {
      data[b.openId] = { name: b.name, source, firstSeenAt: now, lastSeenAt: now };
    }
  }
  writeFileAtomic(dataDir, chatId, data);
}

/**
 * Return non-expired entries for the given chat. `maxAgeMs` defaults to 30
 * days; pass a custom value (or `Infinity`) to override. Order is unspecified
 * — callers needing a deterministic order should sort on their side.
 */
export function listObservedBots(
  dataDir: string,
  chatId: string,
  maxAgeMs: number = DEFAULT_EXPIRY_MS,
  now: number = Date.now(),
): ObservedBot[] {
  const data = readFile(dataDir, chatId);
  const out: ObservedBot[] = [];
  for (const [openId, entry] of Object.entries(data)) {
    if (now - entry.lastSeenAt > maxAgeMs) continue;
    out.push({ openId, name: entry.name, source: entry.source, firstSeenAt: entry.firstSeenAt, lastSeenAt: entry.lastSeenAt });
  }
  return out;
}
