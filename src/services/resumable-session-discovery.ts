/**
 * Resumable-session discovery — scan a CLI's on-disk transcript store and
 * surface the sessions a user can *resume* (paseo-style import), independent of
 * whether the original CLI is still running in tmux. This powers the second
 * filter of `/adopt`: pick a stored session → botmux spawns a fresh worker that
 * runs `<cli> --resume <id>` in the recorded cwd.
 *
 * Three storage shapes are covered (one parser each, shared across CLIs):
 *   - Claude-family JSONL  (`claude-code`, `seed`): <dataDir>/projects/<hash>/<id>.jsonl
 *   - Codex/TRAE rollout   (`codex`, `traex`):       <sessionsRoot>/YYYY/MM/DD/rollout-*.jsonl
 *   - Antigravity history  (`antigravity`):          <home>/history.jsonl (flat submit log)
 *
 * All scans are daemon-side, pure filesystem (no PTY / subprocess), and run
 * only on an explicit `/adopt` — so we favour correctness + bounded I/O over
 * cleverness: take the most-recent files by mtime, read a bounded prefix of
 * each (session id / cwd / first prompt all live near the top), parse line by
 * line, stop early.
 */
import { promises as fs, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import type { ResumableSession } from '../adapters/cli/types.js';

const TITLE_MAX = 80;

/** Safety cap on lines scanned per transcript when searching for the metadata
 *  we need (session id / cwd / first prompt). All three live near the top of
 *  claude/rollout transcripts, so the early-stop almost always fires first;
 *  this only bounds pathological / corrupt files. Antigravity's flat submit log
 *  is read in full (see its own higher cap) so tail entries are never missed. */
const MAX_LINES_PER_FILE = 5_000;

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** Stream a JSONL file line by line, invoking `onLine` for each parsed object.
 *  Return `true` from `onLine` to stop early (closes the stream). Reading
 *  COMPLETE lines — rather than a fixed byte prefix — is deliberate: a single
 *  oversized first record (e.g. a 200KiB user prompt) must still be parsed
 *  whole to recover its `cwd`, and an append-only log's freshest entries live
 *  at the tail. Swallows fs/parse errors (missing file, corrupt line) so a bad
 *  transcript degrades to "skipped", never throws. */
async function forEachJsonLine(
  path: string,
  onLine: (rec: Record<string, unknown>) => boolean | void,
  maxLines = MAX_LINES_PER_FILE,
): Promise<void> {
  const stream = createReadStream(path, { encoding: 'utf8' });
  // A missing/unreadable file emits 'error' asynchronously; without a listener
  // that becomes an unhandled error. Absorb it — the for-await below also
  // rejects and is caught, but the listener guarantees no stray crash.
  stream.on('error', () => { /* handled via try/catch */ });
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const raw of rl) {
      const line = raw.trim();
      if (line) {
        let parsed: unknown = null;
        try { parsed = JSON.parse(line); } catch { /* corrupt line — skip */ }
        const rec = asRecord(parsed);
        if (rec && onLine(rec) === true) break;
      }
      if (++n >= maxLines) break;
    }
  } catch {
    // missing file / read error — return what we have
  } finally {
    rl.close();
    stream.destroy();
  }
}

function truncateTitle(text: string): string {
  const norm = text.replace(/\s+/g, ' ').trim();
  if (!norm) return '';
  return norm.length > TITLE_MAX ? `${norm.slice(0, TITLE_MAX - 1)}…` : norm;
}

/** botmux wraps every forwarded user message before handing it to the CLI, in
 *  one of two historical shapes: `<user_message>…</user_message>` (current) or
 *  `用户发送了：\n---\n<text>\n---\n…` (older). For a cleaner picker title, peel the
 *  wrapper off when present; otherwise return as-is (sessions started outside
 *  botmux carry the raw prompt and are left untouched). */
function unwrapBotmuxPrompt(text: string): string {
  const xml = text.match(/<user_message>\s*([\s\S]*?)\s*<\/user_message>/);
  if (xml) return xml[1]!;
  const legacy = text.match(/^用户发送了：\s*\n-{3,}\n([\s\S]*?)\n-{3,}/);
  return legacy ? legacy[1]! : text;
}

interface FileEntry { path: string; mtimeMs: number; }

/** Recursively collect `*.jsonl` files under `root`, returning the most-recently
 *  modified `limit` of them. Bounded depth so a pathological tree can't wedge
 *  the scan. */
async function collectRecentJsonl(root: string, limit: number, maxDepth = 4): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    let dirents;
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    await Promise.all(dirents.map(async (d) => {
      const full = join(dir, d.name);
      if (d.isDirectory()) {
        await walk(full, depth + 1);
      } else if (d.isFile() && d.name.endsWith('.jsonl')) {
        try {
          const st = await fs.stat(full);
          out.push({ path: full, mtimeMs: st.mtimeMs });
        } catch { /* ignore */ }
      }
    }));
  }
  await walk(root, 0);
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, limit);
}

// ─── Claude-family JSONL (claude-code, seed) ─────────────────────────────────

/** Parse one Claude JSONL transcript. The session id is the filename; cwd +
 *  first user prompt come from the content (streamed line by line, stopping
 *  once both are found). Sidechain / synthetic / slash-command entries are
 *  skipped so the title is the user's real first turn. */
async function parseClaudeTranscript(path: string, mtimeMs: number): Promise<ResumableSession | null> {
  const cliSessionId = basename(path, '.jsonl');
  if (!cliSessionId) return null;
  // Accumulate into an object (see parseRolloutTranscript) so the post-loop
  // guard narrows correctly despite closure mutation.
  const acc: { cwd: string | null; title: string } = { cwd: null, title: '' };
  await forEachJsonLine(path, (rec) => {
    if (rec.isSidechain === true) return;
    if (!acc.cwd && typeof rec.cwd === 'string') acc.cwd = rec.cwd;
    if (!acc.title && rec.type === 'user') {
      const text = extractClaudeUserText(rec.message);
      if (text) acc.title = truncateTitle(text);
    }
    return Boolean(acc.cwd && acc.title); // stop once we have everything
  });
  if (!acc.cwd) return null;
  return { cliSessionId, cwd: acc.cwd, title: acc.title || `Claude ${cliSessionId.slice(0, 8)}`, lastActivityAt: mtimeMs };
}

/** Pull plain user text out of a Claude `message` field, skipping tool-result
 *  array content and slash-command meta lines (which start with `<command-…>`
 *  or are pure `/cmd` invocations — not a meaningful conversation title). */
function extractClaudeUserText(message: unknown): string | null {
  const msg = asRecord(message);
  if (!msg || msg.role !== 'user') return null;
  let text: string | null = null;
  if (typeof msg.content === 'string') {
    text = msg.content;
  } else if (Array.isArray(msg.content)) {
    const part = msg.content.find((p) => asRecord(p)?.type === 'text');
    const t = asRecord(part)?.text;
    if (typeof t === 'string') text = t;
  }
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('<command-') || trimmed.startsWith('<local-command')) return null;
  return unwrapBotmuxPrompt(trimmed);
}

export async function discoverClaudeFamilySessions(dataDir: string, limit: number): Promise<ResumableSession[]> {
  const projectsRoot = join(dataDir, 'projects');
  const files = await collectRecentJsonl(projectsRoot, limit * 3, 2);
  const parsed = await Promise.all(files.map((f) => parseClaudeTranscript(f.path, f.mtimeMs)));
  return parsed.filter((s): s is ResumableSession => s !== null).slice(0, limit);
}

// ─── Codex / TRAE rollout (codex, traex) ─────────────────────────────────────

/** Parse one Codex/TRAE rollout. `session_meta` carries the resume id + cwd;
 *  the first `event_msg`/`user_message` carries the user's first prompt (the
 *  `response_item` role:user entries include the synthetic
 *  <environment_context>/<permissions> preamble, so we prefer user_message).
 *  Streamed line by line, stopping once id + cwd + title are found. */
async function parseRolloutTranscript(path: string, mtimeMs: number): Promise<ResumableSession | null> {
  // Accumulate into an object — closure mutation of plain `let` defeats TS's
  // control-flow narrowing at the post-loop guard; object properties keep their
  // declared type.
  const acc: { id: string | null; cwd: string | null; title: string } = { id: null, cwd: null, title: '' };
  await forEachJsonLine(path, (rec) => {
    const payload = asRecord(rec.payload);
    if (rec.type === 'session_meta' && payload) {
      if (typeof payload.id === 'string') acc.id = payload.id;
      if (typeof payload.cwd === 'string') acc.cwd = payload.cwd;
    } else if (!acc.title && rec.type === 'event_msg' && payload?.type === 'user_message') {
      if (typeof payload.message === 'string') acc.title = truncateTitle(unwrapBotmuxPrompt(payload.message));
    }
    return Boolean(acc.id && acc.cwd && acc.title);
  });
  if (!acc.id || !acc.cwd) return null;
  return { cliSessionId: acc.id, cwd: acc.cwd, title: acc.title || `Session ${acc.id.slice(0, 8)}`, lastActivityAt: mtimeMs };
}

export async function discoverRolloutSessions(sessionsRoot: string, limit: number): Promise<ResumableSession[]> {
  const files = await collectRecentJsonl(sessionsRoot, limit * 3, 5);
  const parsed = await Promise.all(files.map((f) => parseRolloutTranscript(f.path, f.mtimeMs)));
  return parsed.filter((s): s is ResumableSession => s !== null).slice(0, limit);
}

// ─── Antigravity flat history log (antigravity) ──────────────────────────────

/** Antigravity appends one line per submit: `{display, timestamp, workspace,
 *  conversationId}`. This is an append-only log — the freshest conversations
 *  live at the TAIL — so we stream the WHOLE file (a flat submit log, not a
 *  per-session transcript, so it stays small) rather than a bounded prefix that
 *  would hide recent sessions once the file grows. Dedup by conversationId,
 *  keeping the latest timestamp; the first display seen for a conversation is
 *  its title. */
export async function discoverAntigravitySessions(historyPath: string, limit: number): Promise<ResumableSession[]> {
  const byConversation = new Map<string, ResumableSession>();
  // Read the full log (high line cap, no byte prefix) so tail entries are seen.
  await forEachJsonLine(historyPath, (rec) => {
    const conversationId = rec.conversationId;
    const workspace = rec.workspace;
    if (typeof conversationId !== 'string' || !conversationId || typeof workspace !== 'string' || !workspace) return;
    const ts = typeof rec.timestamp === 'number' ? rec.timestamp : 0;
    const display = typeof rec.display === 'string' ? rec.display : '';
    const existing = byConversation.get(conversationId);
    if (!existing) {
      byConversation.set(conversationId, {
        cliSessionId: conversationId,
        cwd: workspace,
        title: truncateTitle(unwrapBotmuxPrompt(display)) || `Conversation ${conversationId.slice(0, 8)}`,
        lastActivityAt: ts,
      });
    } else if (ts > existing.lastActivityAt) {
      existing.lastActivityAt = ts;
    }
  }, 1_000_000);
  return [...byConversation.values()]
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, limit);
}
