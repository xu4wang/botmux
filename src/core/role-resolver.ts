/**
 * Per-bot, per-chat role file resolver.
 *
 * Role definitions live in botmux's session data directory, keyed by the bot's
 * Lark app id and the chat id:
 *   {config.session.dataDir}/roles/{larkAppId}/{chatId}.md
 *
 * Storing under the session data dir (rather than the bot's project workingDir)
 * keeps role config out of the user's code repo, makes it relocate together
 * with the rest of session state via SESSION_DATA_DIR, and keying on larkAppId
 * means two bots that share a workingDir still get independent personas. Role
 * content is injected into the CLI prompt as a <role> block, allowing the same
 * bot to adopt different personas in different Lark groups.
 */

import { existsSync, readFileSync, statSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

const MAX_ROLE_BYTES = 4 * 1024; // 4 KB

interface CacheEntry {
  mtimeMs: number;
  content: string | null; // null = file not found (negative cache)
}

const cache = new Map<string, CacheEntry>();

function cacheKey(larkAppId: string, chatId: string): string {
  return `${larkAppId}::${chatId}`;
}

/** Absolute path to the role file for a given bot + chat. */
function roleFilePath(larkAppId: string, chatId: string): string {
  return join(config.session.dataDir, 'roles', larkAppId, `${chatId}.md`);
}

/** Truncate `content` to at most MAX_ROLE_BYTES UTF-8 bytes. */
function truncateToByteLimit(content: string): string {
  let out = content;
  while (Buffer.byteLength(out, 'utf-8') > MAX_ROLE_BYTES) {
    out = out.slice(0, -1);
  }
  return out;
}

/**
 * Resolve the role content for a given bot (larkAppId) and chat.
 * Returns the role markdown string, or null if no role file exists.
 */
export function resolveRoleFile(larkAppId: string, chatId: string): string | null {
  if (!larkAppId || !chatId) return null;

  const key = cacheKey(larkAppId, chatId);
  const filePath = roleFilePath(larkAppId, chatId);

  let stat: ReturnType<typeof statSync> | null = null;
  try {
    if (!existsSync(filePath)) {
      // Negative cache
      cache.set(key, { mtimeMs: 0, content: null });
      return null;
    }
    stat = statSync(filePath);
  } catch {
    cache.set(key, { mtimeMs: 0, content: null });
    return null;
  }

  // Cache hit — skip read if mtime unchanged
  const cached = cache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs) {
    return cached.content;
  }

  // Read & validate
  try {
    const raw = readFileSync(filePath, 'utf-8');

    // Truncate by UTF-8 byte length, not JS string length (CJK chars are 3 bytes each)
    let content = raw.trim();
    if (Buffer.byteLength(content, 'utf-8') > MAX_ROLE_BYTES) {
      logger.warn(`[role] ${filePath} exceeds ${MAX_ROLE_BYTES} UTF-8 bytes (${Buffer.byteLength(content, 'utf-8')}), truncating`);
      content = truncateToByteLimit(content);
    }

    if (!content) {
      cache.set(key, { mtimeMs: stat.mtimeMs, content: null });
      return null;
    }

    cache.set(key, { mtimeMs: stat.mtimeMs, content });
    logger.info(`[role] chat=${chatId} file=${filePath} (${Buffer.byteLength(content, 'utf-8')} bytes)`);
    return content;
  } catch (err: any) {
    logger.warn(`[role] failed to read ${filePath}: ${err?.message ?? err}`);
    cache.set(key, { mtimeMs: 0, content: null });
    return null;
  }
}

/** Clear the in-memory cache (useful for testing or manual reload). */
export function clearRoleCache(): void {
  cache.clear();
}

/** Invalidate cache for a specific larkAppId + chatId pair. */
export function invalidateRoleCache(larkAppId: string, chatId: string): void {
  cache.delete(cacheKey(larkAppId, chatId));
}

/** Write or overwrite role content for a chat. Creates the parent directory if needed. */
export function writeRoleFile(larkAppId: string, chatId: string, content: string): void {
  const filePath = roleFilePath(larkAppId, chatId);
  mkdirSync(dirname(filePath), { recursive: true });
  // Truncate by UTF-8 byte length, not JS string length
  const trimmed = truncateToByteLimit(content.trim());
  writeFileSync(filePath, trimmed, 'utf-8');
  cache.delete(cacheKey(larkAppId, chatId)); // invalidate so next read picks up the new content
  logger.info(`[role] wrote chat=${chatId} file=${filePath} (${Buffer.byteLength(trimmed, 'utf-8')} bytes)`);
}

/** Delete a role file for a chat. */
export function deleteRoleFile(larkAppId: string, chatId: string): boolean {
  const filePath = roleFilePath(larkAppId, chatId);
  try {
    unlinkSync(filePath);
    cache.delete(cacheKey(larkAppId, chatId));
    logger.info(`[role] deleted chat=${chatId} file=${filePath}`);
    return true;
  } catch (err: any) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    logger.warn(`[role] failed to delete ${filePath}: ${err?.message ?? err}`);
    return false;
  }
}
