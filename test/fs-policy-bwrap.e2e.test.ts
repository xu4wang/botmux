/**
 * Linux bwrap e2e: compile a real FsPolicy → bwrap argv, launch real processes
 * under bubblewrap, and assert the three access tiers actually hold at the
 * KERNEL level (not just in the pure accessForPath model). Skipped off Linux
 * and when bwrap / unprivileged user namespaces are unavailable.
 *
 * This is the guard for blocker #1 (2026-07-24 review): the previous compiler
 * masked DIRECTORY-shaped deny rules with `--tmpfs <path>`, which hides the
 * real contents but leaves a WRITABLE tmpfs inside the sandbox — so a "deny"
 * path was still writable. And a deny path that did NOT exist on the host got a
 * mount that bwrap materialised in the read-write PARENT, leaking a real
 * mountpoint onto the host tree. The fix: ro-bind an empty dir over existing
 * dir denies (unreadable + unwritable), and SKIP nonexistent denies entirely.
 *
 * These assertions run the compiler exactly as the worker does: resolve
 * symlinks, split file- vs dir-shaped denies, record which deny paths exist,
 * pre-create the empty placeholder files, then invoke bwrap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, realpathSync, existsSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';

// bwrap + working unprivileged user namespaces are both required. Some CI
// kernels disable userns; probe with the exact unshare flags the compiler emits.
const bwrapUsable = process.platform === 'linux'
  && spawnSync('sh', ['-c', 'command -v bwrap'], { stdio: 'ignore' }).status === 0
  && spawnSync('bwrap', [
    '--tmpfs', '/', '--proc', '/proc', '--dev', '/dev',
    '--ro-bind', '/usr', '/usr', '--ro-bind', '/bin', '/bin',
    ...(existsSync('/lib') ? ['--ro-bind', '/lib', '/lib'] : []),
    ...(existsSync('/lib64') ? ['--ro-bind', '/lib64', '/lib64'] : []),
    '--unshare-user', '--unshare-pid', '/bin/true',
  ], { stdio: 'ignore' }).status === 0;

const d = bwrapUsable ? describe : describe.skip;

const USRMERGE = ['/bin', '/lib', '/lib64', '/sbin', '/lib32', '/libx32'];

d('bwrap three-tier enforcement (real bubblewrap)', () => {
  let S: string;
  const canonical = (p: string) => { try { return realpathSync(p); } catch { return p; } };

  // Build the bwrap argv prefix the SAME way the worker does, for a policy with
  // an extra deny/readOnly set under the project.
  function buildArgs(extra: { existDenyDir?: boolean; ghostDenyDir?: boolean; denyFile?: boolean }) {
    const emptiesDir = join(S, 'sbx/empties');
    const emptyDir = join(S, 'sbx/empty');
    mkdirSync(emptiesDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });

    const deny: string[] = [];
    if (extra.existDenyDir) deny.push(join(S, 'proj/secrets'));
    if (extra.ghostDenyDir) deny.push(join(S, 'proj/ghost')); // never created on host
    if (extra.denyFile) deny.push(join(S, 'proj/.env'));

    const policy = buildFsPolicy({
      platform: 'linux', homeDir: canonical(homedir()),
      botmuxHome: join(S, 'botmux-home'), sessionDataDir: join(S, 'botmux-home/data'),
      sessionId: 'e2e-session',
      workingDir: join(S, 'proj'), currentAppId: 'cli_e2e', botHome: join(S, 'botmux-home/bots/cli_e2e'),
      redirectedCliData: true,
      execPaths: [dirname(canonical(process.execPath))],
      userPaths: { readOnly: [join(S, 'ref')], deny },
      net: true, writeRegexes: [],
    });
    // Existence-filter the ALLOW rules exactly like the worker (deny kept).
    policy.rules = policy.rules.filter(r => r.access === 'deny' || existsSync(r.path));

    const symlinks: { path: string; target: string }[] = [];
    for (const p of USRMERGE) {
      try { if (lstatSync(p).isSymbolicLink()) symlinks.push({ path: p, target: readlinkSync(p) }); } catch { /* */ }
    }
    const filePaths = new Set<string>();
    const existingPaths = new Set<string>();
    for (const r of policy.rules) {
      if (r.access !== 'deny') continue;
      try { const st = statSync(r.path); existingPaths.add(r.path); if (st.isFile()) filePaths.add(r.path); } catch { /* */ }
    }
    const compiled = compileToBwrap(policy, { symlinks, emptyDir, emptiesDir, filePaths, existingPaths, chdir: join(S, 'proj') });
    for (const f of compiled.emptyFiles) { try { writeFileSync(f.path, ''); } catch { /* */ } }
    // Replicate any non-usrmerge top-level dirs the child needs but the policy
    // didn't cover (none needed here: /usr + execPaths carry node).
    return compiled.args;
  }

  // Run a shell command string inside the sandbox; returns {status, out}.
  function run(extra: Parameters<typeof buildArgs>[0], cmd: string) {
    const r = spawnSync('bwrap', [...buildArgs(extra), '/bin/sh', '-c', cmd], { encoding: 'utf8' });
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
  }

  beforeAll(() => {
    S = canonical(mkdtempSync(join(tmpdir(), 'fsp-bwrap-e2e-')));
    for (const dir of ['proj/secrets', 'proj/work', 'botmux-home/data', 'botmux-home/bots/cli_e2e', 'ref']) {
      mkdirSync(join(S, dir), { recursive: true });
    }
    writeFileSync(join(S, 'proj/readme.md'), 'proj');
    writeFileSync(join(S, 'proj/secrets/key.txt'), 'TOPSECRET');
    writeFileSync(join(S, 'proj/.env'), 'API_KEY=zzz');
    writeFileSync(join(S, 'ref/doc.md'), 'ref');
  });
  afterAll(() => { if (S) rmSync(S, { recursive: true, force: true }); });

  it('readWrite: reads AND writes the project', () => {
    expect(run({}, `cat ${JSON.stringify(join(S, 'proj/readme.md'))}`).status).toBe(0);
    expect(run({}, `echo hi > ${JSON.stringify(join(S, 'proj/work/new.txt'))}`).status).toBe(0);
  });

  it('readOnly: reads but cannot write', () => {
    expect(run({}, `cat ${JSON.stringify(join(S, 'ref/doc.md'))}`).status).toBe(0);
    expect(run({}, `echo x > ${JSON.stringify(join(S, 'ref/hack'))}`).status).not.toBe(0);
  });

  it('deny DIR under a readWrite tree: real content is NOT readable', () => {
    // masked by an empty ro-bind → the real key.txt is invisible
    const r = run({ existDenyDir: true }, `cat ${JSON.stringify(join(S, 'proj/secrets/key.txt'))}`);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('TOPSECRET');
  });

  it('deny DIR under a readWrite tree: is NOT writable (regression — was a writable tmpfs)', () => {
    // The core blocker-1 bug: `--tmpfs <deny>` let the child write into the
    // denied dir. A read-only empty bind must reject the write.
    const evil = join(S, 'proj/secrets/evil.txt');
    const r = run({ existDenyDir: true }, `echo PWNED > ${JSON.stringify(evil)}`);
    expect(r.status).not.toBe(0);
    // and nothing leaked back onto the host
    expect(existsSync(evil)).toBe(false);
  });

  it('deny FILE under a readWrite tree: content hidden, not writable', () => {
    const r = run({ denyFile: true }, `cat ${JSON.stringify(join(S, 'proj/.env'))}; echo x > ${JSON.stringify(join(S, 'proj/.env'))} && echo WROTE`);
    expect(r.out).not.toContain('API_KEY');
    expect(r.out).not.toContain('WROTE');
  });

  it('NONEXISTENT deny under a readWrite parent: bwrap creates NO host mountpoint (regression)', () => {
    const ghost = join(S, 'proj/ghost');
    expect(existsSync(ghost)).toBe(false);
    // The deny rule for a nonexistent path must be SKIPPED — otherwise bwrap
    // materialises `proj/ghost` in the read-write parent on the HOST.
    run({ ghostDenyDir: true }, 'true');
    expect(existsSync(ghost)).toBe(false);
  });
});
