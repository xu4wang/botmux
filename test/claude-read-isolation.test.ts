/**
 * Claude adapter × read-isolation. In v2 Claude isolates via the EXTERNAL Seatbelt
 * wrapper (readIsolationMechanism: 'external-wrapper'), NOT by injecting a sandbox
 * block into --settings — buildArgs deliberately ignores the readIsolation context
 * (`void readIsolation`). So the only adapter-level contract left to assert is that
 * it declares the capability and never smuggles a sandbox block into --settings.
 * (The old v1 --settings-injection tests were removed when Claude moved to the
 * external wrapper.)
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }));

import { createClaudeCodeAdapter } from '../src/adapters/cli/claude-code.js';
import type { ReadIsolationContext } from '../src/adapters/cli/read-isolation.js';

function settingsOf(args: string[]): any {
  const idx = args.indexOf('--settings');
  expect(idx).toBeGreaterThanOrEqual(0);
  return JSON.parse(args[idx + 1]);
}

const ctx: ReadIsolationContext = {
  currentAppId: 'cli_self',
  otherAppIds: ['cli_other'],
  sessionDataDir: '/Users/bot/.botmux/data',
  homeDir: '/Users/bot',
  claudeProjectsDir: '/Users/bot/.claude/projects',
};

describe('claude-code adapter × read isolation', () => {
  const adapter = createClaudeCodeAdapter('/usr/bin/claude');

  it('declares read-isolation capability', () => {
    expect(adapter.supportsReadIsolation).toBe(true);
  });

  it('does NOT inject a sandbox block into --settings even when readIsolation is passed (v2 uses the external wrapper)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, readIsolation: ctx });
    const s = settingsOf(args);
    expect(s.sandbox).toBeUndefined();
    // --settings still carries the bypassPermissions default (unrelated to isolation)
    expect(s.permissions?.defaultMode).toBe('bypassPermissions');
  });

  it('does not add sandbox block when readIsolation is absent', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const s = settingsOf(args);
    expect(s.sandbox).toBeUndefined();
  });
});
