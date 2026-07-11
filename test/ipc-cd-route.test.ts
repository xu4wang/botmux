// test/ipc-cd-route.test.ts
//
// POST /api/sessions/:sessionId/cd 路由级分支矩阵（Task 9）。
//
// 手法沿用 test/dashboard-ipc.test.ts：起真实 IPC server（port 0）+ fetch，
// 依赖经 vi.spyOn(模块命名空间) 打桩（vitest 的 vite 转换让被测模块的具名
// import 走命名空间访问，spy 即时生效）。
//
// 角色库根依赖：路由内 validateRoleLibraryPath 无 rootOverride 注入点，
// 采用「临时 HOME」最小方案——role-library 的 roleLibraryRoot() 在每次校验时
// 调用 os.homedir()（POSIX 下优先读 $HOME），故 beforeAll 把 HOME 指到临时
// 目录并在其中建 botmux-roles/role-a，即可用真实校验逻辑（realpath 归一 +
// dev/ino 包含判断）覆盖 403/400 分支，而不 mock role-library 本身。
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as sessionCwd from '../src/core/session-cwd.js';

let handle: IpcServerHandle | null = null;
let prevHome: string | undefined;
let fakeHome: string;
let roleDir: string;      // <fakeHome>/botmux-roles/role-a（角色库内合法目录）
let roleDirReal: string;  // 其 realpath —— validateRoleLibraryPath 的归一化产物

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'ipc-cd-home-'));
  roleDir = join(fakeHome, 'botmux-roles', 'role-a');
  mkdirSync(roleDir, { recursive: true });
  roleDirReal = realpathSync(roleDir);
  prevHome = process.env.HOME;
  process.env.HOME = fakeHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(fakeHome, { recursive: true, force: true });
});

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  vi.restoreAllMocks();
});

async function postCd(sessionId: string, dir?: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/${sessionId}/cd`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(dir === undefined ? {} : { dir }),
  });
}

describe('POST /api/sessions/:sessionId/cd', () => {
  it('404s for sessions that are not active', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('missing', roleDir);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('409s adopt sessions (adoptedFrom set) — injecting or killing would hit the user pane', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt', cliId: 'claude-code' },
      worker: { send, killed: false },
      adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/x' },
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-adopt', roleDir);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_cd_unsupported' });
    expect(send).not.toHaveBeenCalled();
    expect(repinSpy).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('409s adopt sessions (initConfig.adoptMode, adoptedFrom absent)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt-init', cliId: 'claude-code' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
      initConfig: { adoptMode: true },
    } as any);

    const res = await postCd('s-adopt-init', roleDir);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_cd_unsupported' });
  });

  it('403s an existing dir outside the role library root — repin/kill never happen', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-outside', cliId: 'claude-code' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    // fakeHome 真实存在但位于 botmux-roles 之外 → outside_role_library
    const res = await postCd('s-outside', fakeHome);

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ ok: false, error: 'outside_role_library' });
    expect(repinSpy).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('400s a nonexistent dir (dir_not_found)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-noent', cliId: 'claude-code' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});

    const res = await postCd('s-noent', join(fakeHome, 'botmux-roles', 'nope'));

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'dir_not_found' });
    expect(repinSpy).not.toHaveBeenCalled();
  });

  it('400s a missing/empty dir field (empty_path)', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-empty', cliId: 'claude-code' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any);

    const res = await postCd('s-empty');

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ ok: false, error: 'empty_path' });
  });

  it('200 mode:inject — live worker + claude-code capability: repin FIRST, then inject /cd <resolvedPath>', async () => {
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-inject', cliId: 'claude-code' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-inject', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'inject', dir: roleDirReal });
    // TOCTOU 契约：注入命令原样使用校验产出 resolvedPath（realpath 归一），
    // 而非请求原始输入。
    expect(send).toHaveBeenCalledWith({ type: 'inject_command', command: `/cd ${roleDirReal}` });
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
    // 落盘重钉必须先于注入（记录 = 唯一事实源；注入只是让活进程跟上）。
    expect(repinSpy.mock.invocationCallOrder[0]).toBeLessThan(send.mock.invocationCallOrder[0]);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('200 mode:cold-restart — NO live worker: killWorker is STILL called (unconditional, no ds.worker guard)', async () => {
    // 锁定行为：worker 为 null 时也必须调用 killWorker——其内部的
    // destroyOrphanedBackingSession 是清掉 lazy-restore/crash-stopped 场景下
    // 仍绑着旧 cwd 的残留 tmux/herdr/zellij backing session 的唯一路径。
    // 若有人把 `if (ds.worker && !ds.worker.killed)` 守卫加回去，此断言失败。
    const ds = {
      session: { sessionId: 's-cold-noworker', cliId: 'claude-code' },
      worker: null,
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-cold-noworker', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(ds);
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
  });

  it('200 mode:cold-restart — live worker but capability-less CLI (codex): kill, never inject', async () => {
    const send = vi.fn();
    const ds = {
      session: { sessionId: 's-cold-codex', cliId: 'codex' },
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    const repinSpy = vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-cold-codex', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
    expect(send).not.toHaveBeenCalled();
    expect(killSpy).toHaveBeenCalledTimes(1);
    expect(killSpy).toHaveBeenCalledWith(ds);
    expect(repinSpy).toHaveBeenCalledWith(ds, roleDirReal);
  });

  it('200 mode:cold-restart — unknown cliId falls through the catch (no crash)', async () => {
    const ds = {
      session: { sessionId: 's-cold-unknown', cliId: 'no-such-cli' },
      worker: { send: vi.fn(), killed: false },
      adoptedFrom: undefined,
    } as any;
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(ds);
    vi.spyOn(sessionCwd, 'repinSessionWorkingDir').mockImplementation(() => {});
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postCd('s-cold-unknown', roleDir);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, mode: 'cold-restart', dir: roleDirReal });
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});
