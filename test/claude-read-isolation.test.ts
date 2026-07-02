/**
 * Claude adapter × read-isolation: buildArgs merges the per-bot sandbox +
 * permissions.deny into the process-level --settings WITHOUT clobbering the
 * existing bypassPermissions keys.
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

  it('injects sandbox + permissions.deny into --settings when readIsolation is passed', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, readIsolation: ctx });
    const s = settingsOf(args);
    expect(s.sandbox?.enabled).toBe(true);
    expect(s.sandbox?.failIfUnavailable).toBe(true);
    expect(s.sandbox?.filesystem?.denyRead).toContain('/Users/bot/.botmux/bots.json');
    expect(s.permissions?.deny).toContain('Read(//Users/bot/.claude/projects/**)');
    expect(s.permissions?.deny).toContain('Read(//Users/bot/.lark-cli-bots/cli_other/**)');
  });

  it('preserves bypassPermissions while adding deny (merge, not overwrite)', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false, readIsolation: ctx });
    const s = settingsOf(args);
    expect(s.permissions?.defaultMode).toBe('bypassPermissions');
    expect(Array.isArray(s.permissions?.deny)).toBe(true);
  });

  it('does not add sandbox block when readIsolation is absent', () => {
    const args = adapter.buildArgs({ sessionId: 's', resume: false });
    const s = settingsOf(args);
    expect(s.sandbox).toBeUndefined();
  });
});
