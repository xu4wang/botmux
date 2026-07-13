import { describe, it, expect } from 'vitest';
import { codexRpcEligible, paneRunsRemoteTui, RPC_CAPABLE_CLIS, type PaneProbes } from '../src/codex-rpc-lifecycle.js';
import type { DaemonToWorker } from '../src/types.js';

type InitCfg = Extract<DaemonToWorker, { type: 'init' }>;

/** Minimal eligible init config; tests override single fields to prove each
 *  fail-closed gate independently. */
function baseCfg(over: Partial<InitCfg> = {}): InitCfg {
  return {
    type: 'init',
    sessionId: 's1', chatId: 'c1', rootMessageId: 'r1', workingDir: '/tmp/x',
    cliId: 'codex', backendType: 'tmux', prompt: 'hello',
    codexRpcInput: true,
    larkAppId: 'app', larkAppSecret: 'sec',
    ...over,
  } as InitCfg;
}

describe('codexRpcEligible — the eligible base case', () => {
  it('a fresh codex/tmux bot with a prompt + codexRpcInput is eligible', () => {
    expect(codexRpcEligible(baseCfg())).toBe(true);
  });
  it('traex is also RPC-capable', () => {
    expect(codexRpcEligible(baseCfg({ cliId: 'traex' }))).toBe(true);
    expect(RPC_CAPABLE_CLIS.has('traex')).toBe(true);
  });
  it('a resume (no prompt but resume + cliSessionId) is eligible', () => {
    expect(codexRpcEligible(baseCfg({ prompt: '', resume: true, cliSessionId: 'thread-1' }))).toBe(true);
  });
});

describe('codexRpcEligible — every fail-closed gate degrades to paste', () => {
  const cases: Array<[string, Partial<InitCfg>]> = [
    ['codexRpcInput not set', { codexRpcInput: false }],
    ['non-RPC cli (claude)', { cliId: 'claude-code' as any }],
    ['non-tmux backend (pty)', { backendType: 'pty' as any }],
    ['non-tmux backend (herdr)', { backendType: 'herdr' as any }],
    ['adopt mode', { adoptMode: true }],
    ['read isolation', { readIsolation: true }],
    ['sandbox', { sandbox: true }],
    ['disableCliBypass (approval-gated — must not become dangerFullAccess)', { disableCliBypass: true }],
    ['has startupCommands (/effort ordering)', { startupCommands: ['/effort high'] }],
    ['wrapperCli launcher', { wrapperCli: 'aiden x codex' }],
    ['cliPathOverride launcher', { cliPathOverride: '/opt/wrap/codex' }],
    ['no prompt and not a resume', { prompt: '' }],
    ['resume flag but no cliSessionId', { prompt: '', resume: true }],
  ];
  for (const [name, over] of cases) {
    it(`fails closed: ${name}`, () => {
      expect(codexRpcEligible(baseCfg(over))).toBe(false);
    });
  }
});

describe('paneRunsRemoteTui — RPC-owned detection via leaf argv (not pane_current_command)', () => {
  const probes = (tree: Record<number, { argv: string[]; comm?: string; children?: number[] }>, panePid = 100): PaneProbes => ({
    panePidOf: () => panePid,
    argvOf: (pid) => tree[pid]?.argv ?? [],
    commOf: (pid) => tree[pid]?.comm,
    childrenOf: (pid) => tree[pid]?.children ?? [],
  });

  it('direct codex --remote pane → RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'codex', argv: ['codex', '--remote', 'ws://127.0.0.1:9', 'resume', '--no-alt-screen', 'tid'] },
    }))).toBe(true);
  });

  it('nested: shell → codex --remote leaf → RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'zsh', argv: ['-zsh'], children: [200] },
      200: { comm: 'codex', argv: ['/usr/bin/codex', '--remote', 'ws://x', 'resume', 'tid'] },
    }))).toBe(true);
  });

  it('node launcher wrapping codex --remote (comm=node, argv basename=codex) → RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'node', argv: ['node', '/n/bin/codex', '--remote', 'ws://x', 'resume', 'tid'] },
    }))).toBe(true);
  });

  it('native paste codex (resume, NO --remote) → not RPC-owned (fail-closed, boundary #3)', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'codex', argv: ['codex', 'resume', '--dangerously-bypass-approvals-and-sandbox', '--no-alt-screen', 'tid'] },
    }))).toBe(false);
  });

  it('bare shell pane → not RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'zsh', argv: ['-zsh'] },
    }))).toBe(false);
  });

  it('--remote present but NOT codex-family (e.g. ssh) → not RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'ssh', argv: ['ssh', '--remote', 'host'] },
    }))).toBe(false);
  });

  it('unreadable pane pid → not RPC-owned', () => {
    expect(paneRunsRemoteTui('bmx-1', { panePidOf: () => undefined })).toBe(false);
  });

  it('does not loop forever on a cyclic/self-referential tree', () => {
    // pid 100's child is itself — seen-set must prevent an infinite walk.
    expect(paneRunsRemoteTui('bmx-1', probes({
      100: { comm: 'zsh', argv: ['-zsh'], children: [100] },
    }))).toBe(false);
  });
});
