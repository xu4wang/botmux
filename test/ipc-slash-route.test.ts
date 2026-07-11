// test/ipc-slash-route.test.ts
//
// POST /api/sessions/:sessionId/slash 路由级分支矩阵。
//
// 手法沿用 test/ipc-cd-route.test.ts：起真实 IPC server（port 0）+ fetch，
// 依赖经 vi.spyOn(模块命名空间) 打桩（vitest 的 vite 转换让被测模块的具名
// import 走命名空间访问，spy 即时生效）。allowlist 依赖 getBotTuiSlashAllow
// （bot-registry 内存态注册表的只读 accessor）——同样用 vi.spyOn(bot-registry
// 命名空间) 打桩，避免真的注册 bot / 构造 Lark client。
import { describe, it, expect, afterEach, vi } from 'vitest';
import { startIpcServer, type IpcServerHandle } from '../src/core/dashboard-ipc-server.js';
import * as workerPool from '../src/core/worker-pool.js';
import * as botRegistry from '../src/bot-registry.js';

let handle: IpcServerHandle | null = null;

afterEach(async () => {
  if (handle) await handle.close();
  handle = null;
  vi.restoreAllMocks();
});

async function postSlash(sessionId: string, command?: string): Promise<Response> {
  if (!handle) handle = await startIpcServer({ port: 0, host: '127.0.0.1' });
  return fetch(`http://127.0.0.1:${handle.port}/api/sessions/${sessionId}/slash`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(command === undefined ? {} : { command }),
  });
}

describe('POST /api/sessions/:sessionId/slash', () => {
  it('404s for sessions that are not active', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue(undefined);

    const res = await postSlash('missing', '/status');

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ ok: false, error: 'session_not_active' });
  });

  it('409s adopt sessions (adoptedFrom set) — machine injection would collide with the user typing in their own pane', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-adopt', cliId: 'claude-code' },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: { source: 'tmux', tmuxTarget: '0:1.0', cwd: '/x' },
    } as any);

    const res = await postSlash('s-adopt', '/status');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'adopt_inject_unsupported' });
    expect(send).not.toHaveBeenCalled();
  });

  it('409s when there is no live worker', async () => {
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-noworker', cliId: 'claude-code' },
      larkAppId: 'app-1',
      worker: null,
      adoptedFrom: undefined,
    } as any);

    const res = await postSlash('s-noworker', '/status');

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ ok: false, error: 'no_live_worker' });
  });

  it('403s: empty/unconfigured allowlist denies by default, and /cd stays forbidden even when allowlisted', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-403', cliId: 'claude-code' },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    const allowSpy = vi.spyOn(botRegistry, 'getBotTuiSlashAllow');

    // 未配置 allowlist（undefined）→ 默认全拒。
    allowSpy.mockReturnValue(undefined);
    const resEmpty = await postSlash('s-403', '/status');
    expect(resEmpty.status).toBe(403);
    expect(await resEmpty.json()).toMatchObject({ ok: false, error: 'allowlist_empty' });

    // /cd 即使出现在 allowlist 里也被固定黑名单拒绝——它必须走专用 cd 路由。
    allowSpy.mockReturnValue(['/cd', '/status']);
    const resForbidden = await postSlash('s-403', '/cd /tmp');
    expect(resForbidden.status).toBe(403);
    expect(await resForbidden.json()).toMatchObject({ ok: false, error: 'command_forbidden' });

    expect(send).not.toHaveBeenCalled();
  });

  it('200 queues an allowlisted command — worker.send gets a bare inject_command (no updateWorkingDir)', async () => {
    const send = vi.fn();
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-ok', cliId: 'claude-code' },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);

    const res = await postSlash('s-ok', '/status');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sessionId: 's-ok', queued: '/status' });
    // 与 cd 路由的区别：通用 slash 注入不带 workingDir 更新（只有 cd 路由才带）。
    expect(send).toHaveBeenCalledWith({ type: 'inject_command', command: '/status' });
    expect(send.mock.calls[0][0]).not.toHaveProperty('updateWorkingDir');
  });

  it('502s when worker.send() throws — slash is stateless, no repin to reconcile, so no kill needed', async () => {
    const send = vi.fn(() => { throw new Error('EPIPE: worker channel closed'); });
    vi.spyOn(workerPool, 'findActiveBySessionId').mockReturnValue({
      session: { sessionId: 's-send-throws', cliId: 'claude-code' },
      larkAppId: 'app-1',
      worker: { send, killed: false },
      adoptedFrom: undefined,
    } as any);
    vi.spyOn(botRegistry, 'getBotTuiSlashAllow').mockReturnValue(['/status']);
    const killSpy = vi.spyOn(workerPool, 'killWorker').mockImplementation(() => {});

    const res = await postSlash('s-send-throws', '/status');

    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ ok: false, error: 'worker_send_failed' });
    expect(killSpy).not.toHaveBeenCalled();
  });
});
