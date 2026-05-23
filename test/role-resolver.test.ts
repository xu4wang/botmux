/**
 * Per-bot, per-chat role resolution + prompt injection.
 *
 * Guards the storage contract (under config.session.dataDir, keyed by
 * larkAppId so bots sharing a workingDir stay isolated) and that
 * buildNewTopicPrompt injects a <role> block when given { larkAppId, chatId }.
 * Run: pnpm vitest run test/role-resolver.test.ts
 */
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

let dataDir: string;

/** Re-import role-resolver (and config) fresh so SESSION_DATA_DIR is honored. */
async function fresh() {
  vi.resetModules();
  return import('../src/core/role-resolver.js');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-role-'));
  process.env.SESSION_DATA_DIR = dataDir;
});
afterEach(() => { delete process.env.SESSION_DATA_DIR; vi.restoreAllMocks(); });

describe('role-resolver storage', () => {
  it('writes under {dataDir}/roles/{larkAppId}/{chatId}.md and reads it back', async () => {
    const { writeRoleFile, resolveRoleFile } = await fresh();
    writeRoleFile('app1', 'oc_x', '# 代码审查员\n严肃，只看正确性。');
    const expectedPath = join(dataDir, 'roles', 'app1', 'oc_x.md');
    expect(existsSync(expectedPath)).toBe(true);
    expect(resolveRoleFile('app1', 'oc_x')).toContain('代码审查员');
  });

  it('keys on larkAppId — two bots sharing a chatId do not collide', async () => {
    const { writeRoleFile, resolveRoleFile } = await fresh();
    writeRoleFile('app1', 'oc_shared', 'role-A');
    writeRoleFile('app2', 'oc_shared', 'role-B');
    expect(resolveRoleFile('app1', 'oc_shared')).toBe('role-A');
    expect(resolveRoleFile('app2', 'oc_shared')).toBe('role-B');
  });

  it('returns null when no role file exists, and after delete', async () => {
    const { writeRoleFile, resolveRoleFile, deleteRoleFile } = await fresh();
    expect(resolveRoleFile('app1', 'oc_none')).toBeNull();
    writeRoleFile('app1', 'oc_y', 'hi');
    expect(deleteRoleFile('app1', 'oc_y')).toBe(true);
    expect(resolveRoleFile('app1', 'oc_y')).toBeNull();
    expect(deleteRoleFile('app1', 'oc_y')).toBe(false); // already gone
  });

  it('truncates content to 4 KB by UTF-8 byte length (CJK is 3 bytes)', async () => {
    const { writeRoleFile, resolveRoleFile } = await fresh();
    writeRoleFile('app1', 'oc_big', '中'.repeat(2000)); // 6000 bytes
    const got = resolveRoleFile('app1', 'oc_big')!;
    expect(Buffer.byteLength(got, 'utf-8')).toBeLessThanOrEqual(4096);
  });
});

describe('buildNewTopicPrompt role injection', () => {
  it('injects a <role> block when { larkAppId, chatId } resolves a role', async () => {
    await fresh();
    const { writeRoleFile } = await import('../src/core/role-resolver.js');
    writeRoleFile('app1', 'oc_z', 'PERSONA_MARKER');
    const { buildNewTopicPrompt } = await import('../src/core/session-manager.js');
    const prompt = buildNewTopicPrompt(
      'hello', 'sess1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_z' },
    );
    expect(prompt).toContain('<role context="group" chat_id="oc_z">');
    expect(prompt).toContain('PERSONA_MARKER');
  });

  it('omits the <role> block when no role exists', async () => {
    await fresh();
    const { buildNewTopicPrompt } = await import('../src/core/session-manager.js');
    const prompt = buildNewTopicPrompt(
      'hello', 'sess1', 'claude-code', undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      { larkAppId: 'app1', chatId: 'oc_absent' },
    );
    expect(prompt).not.toContain('<role');
  });
});
