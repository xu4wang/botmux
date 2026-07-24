/**
 * Linux bwrap e2e: compile a real FsPolicy → bwrap argv, launch real processes
 * under bubblewrap, and assert the three access tiers hold at the KERNEL level
 * (not just in the pure accessForPath model). Skipped off Linux and when bwrap
 * / unprivileged user namespaces are unavailable.
 *
 * Guards the blocker-1 findings from the 2026-07-24 review:
 *  (a) DIRECTORY deny masked with `--tmpfs` was WRITABLE inside the sandbox —
 *      hid contents but let the CLI write into the "denied" path. Fixed with a
 *      read-only bind of a mode-000 empty source.
 *  (b) A nonexistent deny was SKIPPED, leaving the path inside the read-write
 *      parent bind: the sandbox could mkdir+write it onto the host, and the
 *      host creating a secret there mid-session became readable (stat→exec
 *      TOCTOU). Fixed by ALWAYS masking a reachable deny (worker pre-creates
 *      the mountpoint so the empty mask always binds).
 *  (c) 0755/0644 masks were themselves readable (`ls`/`cat` succeeded on the
 *      empty mask). Fixed with mode 000 → the access command itself fails.
 *
 * This runs the compiler exactly as the worker does: resolve symlinks, split
 * file- vs dir-shaped denies, mode-000 the empty sources, pre-create missing
 * mask mountpoints, then invoke bwrap.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, rmdirSync, writeFileSync, mkdirSync, chmodSync, realpathSync, existsSync, statSync, lstatSync, readlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { buildFsPolicy, compileToBwrap } from '../src/adapters/cli/fs-policy.js';

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

  // Build the bwrap argv the SAME way the worker does (deny masks: mode-000
  // empty sources, missing mountpoints pre-created). Returns the created-mask
  // list too so cleanup tests can assert rmdir-if-empty.
  function build(extraDeny: string[]) {
    const emptiesDir = join(S, 'sbx/empties');
    const emptyDir = join(S, 'sbx/empty');
    mkdirSync(emptiesDir, { recursive: true });
    mkdirSync(emptyDir, { recursive: true });

    const policy = buildFsPolicy({
      platform: 'linux', homeDir: canonical(homedir()),
      botmuxHome: join(S, 'botmux-home'), sessionDataDir: join(S, 'botmux-home/data'),
      sessionId: 'e2e-session',
      workingDir: join(S, 'proj'), currentAppId: 'cli_e2e', botHome: join(S, 'botmux-home/bots/cli_e2e'),
      redirectedCliData: true,
      execPaths: [dirname(canonical(process.execPath))],
      userPaths: { readOnly: [join(S, 'ref')], deny: extraDeny },
      net: true, writeRegexes: [],
    });
    policy.rules = policy.rules.filter(r => r.access === 'deny' || existsSync(r.path));

    const symlinks: { path: string; target: string }[] = [];
    for (const p of USRMERGE) {
      try { if (lstatSync(p).isSymbolicLink()) symlinks.push({ path: p, target: readlinkSync(p) }); } catch { /* */ }
    }
    const filePaths = new Set<string>();
    for (const r of policy.rules) {
      if (r.access !== 'deny') continue;
      try { if (statSync(r.path).isFile()) filePaths.add(r.path); } catch { /* absent → dir mask */ }
    }
    const compiled = compileToBwrap(policy, { symlinks, emptyDir, emptiesDir, filePaths, chdir: join(S, 'proj') });
    chmodSync(emptyDir, 0o000);
    for (const f of compiled.emptyFiles) writeFileSync(f.path, '', { mode: 0o000 });
    const created: { path: string; kind: 'dir' | 'file' }[] = [];
    for (const m of compiled.maskMounts) {
      if (existsSync(m.path)) continue;
      if (m.kind === 'file') { mkdirSync(dirname(m.path), { recursive: true }); writeFileSync(m.path, ''); }
      else mkdirSync(m.path, { recursive: true });
      created.push(m);
    }
    return { args: compiled.args, created };
  }

  function run(args: string[], cmd: string) {
    const r = spawnSync('bwrap', [...args, '/bin/sh', '-c', cmd], { encoding: 'utf8' });
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
    const { args } = build([]);
    expect(run(args, `cat ${JSON.stringify(join(S, 'proj/readme.md'))}`).status).toBe(0);
    expect(run(args, `echo hi > ${JSON.stringify(join(S, 'proj/work/new.txt'))}`).status).toBe(0);
  });

  it('readOnly: reads but cannot write', () => {
    const { args } = build([]);
    expect(run(args, `cat ${JSON.stringify(join(S, 'ref/doc.md'))}`).status).toBe(0);
    expect(run(args, `echo x > ${JSON.stringify(join(S, 'ref/hack'))}`).status).not.toBe(0);
  });

  it('deny DIR (existing): real content unreadable AND the mask itself is unreadable (mode 000)', () => {
    const dir = join(S, 'proj/secrets');
    const { args } = build([dir]);
    const read = run(args, `cat ${JSON.stringify(join(dir, 'key.txt'))}`);
    expect(read.status).not.toBe(0);
    expect(read.out).not.toContain('TOPSECRET');
    // the mask itself must not even be listable (000, not an empty-but-readable dir)
    const ls = run(args, `ls ${JSON.stringify(dir)}`);
    expect(ls.status).not.toBe(0);
  });

  it('deny DIR (existing): NOT writable — regression guard for the writable-tmpfs bug', () => {
    const dir = join(S, 'proj/secrets');
    const evil = join(dir, 'evil.txt');
    const { args } = build([dir]);
    expect(run(args, `echo PWNED > ${JSON.stringify(evil)}`).status).not.toBe(0);
    expect(existsSync(evil)).toBe(false); // nothing leaked to the host
  });

  it('deny FILE (existing): content hidden, cat fails (000), write rejected', () => {
    const f = join(S, 'proj/.env');
    const { args } = build([f]);
    const r = run(args, `cat ${JSON.stringify(f)}; echo x > ${JSON.stringify(f)} && echo WROTE`);
    expect(r.out).not.toContain('API_KEY');
    expect(r.out).not.toContain('WROTE');
  });

  it('NONEXISTENT deny under a RW parent: sandbox mkdir/write is REJECTED and nothing lands on the host', () => {
    const ghost = join(S, 'proj/ghost'); // never created as a real secret
    expect(existsSync(join(ghost, 'x'))).toBe(false);
    const { args } = build([ghost]);
    const r = run(args, `mkdir -p ${JSON.stringify(join(ghost, 'sub'))} 2>&1; echo LEAK > ${JSON.stringify(join(ghost, 'secret'))} 2>&1 && echo WROTE`);
    expect(r.out).not.toContain('WROTE');
    expect(existsSync(join(ghost, 'secret'))).toBe(false);
    expect(existsSync(join(ghost, 'sub'))).toBe(false);
  });

  it('RO parent + deny created by the HOST mid-session: sandbox still cannot read it', () => {
    // ref/ is readOnly; ref/private does NOT exist at build time. The mask must
    // still be installed so a host-created secret is unreadable in-sandbox.
    const priv = join(S, 'ref/private');
    rmSync(priv, { recursive: true, force: true });
    const { args } = build([priv]);
    // simulate the host/another process creating the secret AFTER the mask was
    // installed (the compiler is stat-free; the worker pre-created the mount).
    // Under the mask, the in-sandbox view is the mode-000 empty source, so even
    // if the host writes into the REAL dir, the sandbox sees EPERM.
    writeFileSync(join(priv, 'k'), 'LATESECRET');
    const r = run(args, `cat ${JSON.stringify(join(priv, 'k'))}`);
    expect(r.status).not.toBe(0);
    expect(r.out).not.toContain('LATESECRET');
    rmSync(priv, { recursive: true, force: true });
  });

  it('cleanup: rmdir-if-empty removes a pre-created empty mount, KEEPS one the host wrote into', () => {
    const ghostEmpty = join(S, 'proj/ghost-empty');
    const ghostFilled = join(S, 'proj/ghost-filled');
    rmSync(ghostEmpty, { recursive: true, force: true });
    rmSync(ghostFilled, { recursive: true, force: true });
    const { created } = build([ghostEmpty, ghostFilled]);
    expect(created.map(m => m.path).sort()).toEqual([ghostFilled, ghostEmpty].sort());
    // host writes into one of them during the session
    writeFileSync(join(ghostFilled, 'hostdata'), 'x');
    // reclaim: rmdir only empty ones (mirrors reclaimMaskMounts semantics)
    for (const m of created) {
      try { rmdirSync(m.path); } catch { /* ENOTEMPTY → kept */ }
    }
    expect(existsSync(ghostEmpty)).toBe(false); // empty → reclaimed
    expect(existsSync(ghostFilled)).toBe(true); // non-empty → preserved, never rm -rf
    rmSync(ghostFilled, { recursive: true, force: true });
  });
});
