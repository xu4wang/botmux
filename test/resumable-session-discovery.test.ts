import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discoverClaudeFamilySessions,
  discoverRolloutSessions,
  discoverAntigravitySessions,
} from '../src/services/resumable-session-discovery.js';

/**
 * Unit coverage for the on-disk session discovery that powers /adopt's second
 * filter (paseo-style resume import). Each parser is fed a temp fixture shaped
 * like the real CLI store (verified against live ~/.claude, ~/.codex, ~/.trae,
 * ~/.gemini data during development) so a format regression fails loudly.
 */

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const jsonl = (...lines: unknown[]): string => lines.map((l) => JSON.stringify(l)).join('\n') + '\n';

describe('discoverClaudeFamilySessions', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = tmp('bmx-claude-'); });

  function writeSession(projectHash: string, sessionId: string, lines: unknown[]): void {
    const dir = join(dataDir, 'projects', projectHash);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sessionId}.jsonl`), jsonl(...lines));
  }

  it('extracts sessionId (from filename), cwd and first user prompt', async () => {
    writeSession('-root-proj', 'aaaa1111-0000-0000-0000-000000000001', [
      { type: 'mode', mode: 'normal', sessionId: 'aaaa1111-0000-0000-0000-000000000001' },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'fix the parser bug' } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cliSessionId: 'aaaa1111-0000-0000-0000-000000000001',
      cwd: '/root/proj',
      title: 'fix the parser bug',
    });
  });

  it('skips sidechain entries and slash-command meta lines when picking a title', async () => {
    writeSession('-root-proj', 'bbbb2222-0000-0000-0000-000000000002', [
      { type: 'user', cwd: '/root/proj', isSidechain: true, message: { role: 'user', content: 'subagent noise' } },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: '<command-name>/clear</command-name>' } },
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: 'the real first question' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('the real first question');
  });

  it('unwraps the botmux <user_message> wrapper for a clean title', async () => {
    writeSession('-root-proj', 'cccc3333-0000-0000-0000-000000000003', [
      { type: 'user', cwd: '/root/proj', message: { role: 'user', content: '<user_message>\n@Claude do the thing\n</user_message>\n<sender />' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out[0]?.title).toBe('@Claude do the thing');
  });

  it('drops transcripts with no cwd, returns most-recent first within limit', async () => {
    writeSession('-a', 'no-cwd-session', [{ type: 'user', message: { role: 'user', content: 'hi' } }]);
    writeSession('-b', 'has-cwd-session', [{ type: 'user', cwd: '/root/b', message: { role: 'user', content: 'hi b' } }]);
    const out = await discoverClaudeFamilySessions(dataDir, 1);
    expect(out).toHaveLength(1);
    expect(out[0]?.cliSessionId).toBe('has-cwd-session');
  });

  it('returns [] when the projects dir is absent', async () => {
    expect(await discoverClaudeFamilySessions(join(dataDir, 'nope'), 10)).toEqual([]);
  });

  // Regression (Codex blocker 2): a first user record larger than any fixed
  // read-prefix must NOT be truncated mid-line and dropped — streaming reads
  // the complete line so cwd is still recovered.
  it('handles an oversized (>200KiB) first user record without dropping the session', async () => {
    const huge = 'x'.repeat(220 * 1024);
    writeSession('-root-big', 'dddd4444-0000-0000-0000-000000000004', [
      { type: 'user', cwd: '/root/big', message: { role: 'user', content: huge } },
      { type: 'assistant', message: { role: 'assistant', content: 'ok' } },
    ]);
    const out = await discoverClaudeFamilySessions(dataDir, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ cliSessionId: 'dddd4444-0000-0000-0000-000000000004', cwd: '/root/big' });
    expect(out[0]!.title.length).toBeLessThanOrEqual(80);
  });
});

describe('discoverRolloutSessions (codex / traex)', () => {
  let sessionsRoot: string;
  beforeEach(() => { sessionsRoot = tmp('bmx-rollout-'); });

  function writeRollout(relDir: string, name: string, lines: unknown[]): void {
    const dir = join(sessionsRoot, relDir);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), jsonl(...lines));
  }

  it('reads resume id + cwd from session_meta and title from the first user_message event', async () => {
    writeRollout('2026/06/13', 'rollout-2026-06-13T07-02-46-019ebfca.jsonl', [
      { timestamp: '2026-06-13T07:02:46Z', type: 'session_meta', payload: { id: '019ebfca-4b59-7131-a924-440904afaff1', cwd: '/root/iserver/botmux' } },
      // Synthetic preamble (response_item role:user) must NOT become the title.
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n  <cwd>/root</cwd>\n</environment_context>' }] } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'refactor the rollout parser' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      cliSessionId: '019ebfca-4b59-7131-a924-440904afaff1',
      cwd: '/root/iserver/botmux',
      title: 'refactor the rollout parser',
    });
  });

  it('unwraps the botmux user_message wrapper', async () => {
    writeRollout('2026/06/12', 'rollout-x.jsonl', [
      { type: 'session_meta', payload: { id: 'sid-2', cwd: '/root/x' } },
      { type: 'event_msg', payload: { type: 'user_message', message: '用户发送了：\n---\nactual prompt\n---\n\nSession ID: zzz' } },
    ]);
    const out = await discoverRolloutSessions(sessionsRoot, 10);
    expect(out[0]?.title).toBe('actual prompt');
  });

  it('drops rollouts missing session_meta id/cwd', async () => {
    writeRollout('2026/06/01', 'rollout-bad.jsonl', [
      { type: 'session_meta', payload: { id: 'only-id' } },
      { type: 'event_msg', payload: { type: 'user_message', message: 'orphan' } },
    ]);
    expect(await discoverRolloutSessions(sessionsRoot, 10)).toEqual([]);
  });
});

describe('discoverAntigravitySessions', () => {
  let dir: string;
  let historyPath: string;
  beforeEach(() => { dir = tmp('bmx-agy-'); historyPath = join(dir, 'history.jsonl'); });

  it('dedups by conversationId, keeps the latest timestamp, first display as title', async () => {
    writeFileSync(historyPath, jsonl(
      { display: 'first turn', timestamp: 1000, workspace: '/root/p1', conversationId: 'conv-1' },
      { display: 'second turn', timestamp: 2000, workspace: '/root/p1', conversationId: 'conv-1' },
      { display: 'other convo', timestamp: 1500, workspace: '/root/p2', conversationId: 'conv-2' },
    ));
    const out = await discoverAntigravitySessions(historyPath, 10);
    expect(out).toHaveLength(2);
    // conv-1 sorts first (latest activity 2000) and keeps its first display.
    expect(out[0]).toMatchObject({ cliSessionId: 'conv-1', cwd: '/root/p1', title: 'first turn', lastActivityAt: 2000 });
    expect(out[1]).toMatchObject({ cliSessionId: 'conv-2', title: 'other convo' });
  });

  it('skips entries missing conversationId or workspace', async () => {
    writeFileSync(historyPath, jsonl(
      { display: 'no convo', timestamp: 1, workspace: '/root/p' },
      { display: 'no workspace', timestamp: 2, conversationId: 'c' },
    ));
    expect(await discoverAntigravitySessions(historyPath, 10)).toEqual([]);
  });

  it('returns [] when the history file is absent', async () => {
    expect(await discoverAntigravitySessions(join(dir, 'nope.jsonl'), 10)).toEqual([]);
  });

  // Regression (Codex blocker 1): history.jsonl is append-only, so the newest
  // conversation lives at the TAIL. A bounded head-prefix read would hide it
  // once the file grows large; streaming the whole log must surface it.
  it('surfaces a newest conversation appended past a >4MiB tail boundary', () => {
    const lines: string[] = [];
    lines.push(JSON.stringify({ display: 'old one', timestamp: 1000, workspace: '/root/old', conversationId: 'conv-old' }));
    // Pad with >4MiB of an unrelated conversation's submits.
    const pad = 'p'.repeat(4096);
    for (let i = 0; i < 1100; i++) {
      lines.push(JSON.stringify({ display: pad, timestamp: 2000 + i, workspace: '/root/pad', conversationId: 'conv-pad' }));
    }
    lines.push(JSON.stringify({ display: 'brand new', timestamp: 9_000_000, workspace: '/root/new', conversationId: 'conv-new' }));
    writeFileSync(historyPath, lines.join('\n') + '\n');
    return discoverAntigravitySessions(historyPath, 10).then((out) => {
      const ids = out.map((s) => s.cliSessionId);
      expect(ids).toContain('conv-new');
      // newest timestamp sorts first
      expect(out[0]).toMatchObject({ cliSessionId: 'conv-new', cwd: '/root/new', title: 'brand new' });
    });
  });
});
