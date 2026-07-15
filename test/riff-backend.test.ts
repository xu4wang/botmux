/**
 * Unit tests for RiffBackend — write serialization (no duplicate task-execute
 * on rapid writes) and sandbox access-URL handling (directAccessUrl preference
 * + accessUrl origin rewrite onto the configured baseUrl).
 *
 * Run:  pnpm vitest run test/riff-backend.test.ts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../src/utils/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { RiffBackend, parseRiffRepoName, deriveRiffRepoFromWorkingDir, deriveRiffReposFromWorkingDir } from '../src/adapters/backend/riff-backend.js';

const BASE = 'https://riff-infra-boe.bytedance.net';

type FetchCall = { url: string; init?: RequestInit };

/** Never-ending SSE body so streamTask stays pending without emitting events. */
function pendingSseResponse(): Response {
  const body = new ReadableStream<Uint8Array>({ start() { /* never pushes */ } });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function taskResponse(id: string, extra: Record<string, unknown> = {}): Response {
  return Response.json({ success: true, data: { id, status: 'running', ...extra } });
}

describe('RiffBackend', () => {
  let calls: FetchCall[];
  let resolvers: Array<(r: Response) => void>;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    calls = [];
    resolvers = [];
    fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes('/api2/task-stream')) return pendingSseResponse();
      if (u.includes('/api/task-detail')) {
        return Response.json({ success: true, data: { task: {} } });
      }
      // task-execute / task-follow-up: resolve manually so tests control timing
      return new Promise<Response>((resolve) => { resolvers.push(resolve); });
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function makeBackend(config: Record<string, unknown> = {}): RiffBackend {
    return new RiffBackend({ baseUrl: BASE, jwt: 'test-jwt', ...config } as any, 'session-1');
  }

  const flush = () => new Promise((r) => setTimeout(r, 0));

  describe('write serialization', () => {
    it('queues a second write until the first task-execute returns (no duplicate createTask)', async () => {
      const be = makeBackend();
      be.spawn('', [], {} as any);

      be.write('first message');
      be.write('second message');
      await flush();

      // Only ONE task-execute in flight — the second write must wait.
      const execCalls = () => calls.filter(c => c.url.includes('/api/task-execute'));
      const followCalls = () => calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(0);

      // First task lands → second write becomes a follow-up, not a new task.
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      expect(execCalls().length).toBe(1);
      expect(followCalls().length).toBe(1);
      const followBody = JSON.parse(String(followCalls()[0]!.init?.body));
      expect(followBody.parentTaskId).toBe('task-1');
      expect(String(followBody.prompt)).toContain('second message');
    });

    it('routes the next message after task completion to follow-up (sandbox continuity)', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      // Task completes — the next turn must still follow up on task-1, not
      // cold-boot a brand-new task/sandbox.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');

      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-2'));
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(1);
      const follow = calls.filter(c => c.url.includes('/api/task-follow-up'));
      expect(follow.length).toBe(1);
      expect(JSON.parse(String(follow[0]!.init?.body)).parentTaskId).toBe('task-1');
    });

    it('falls back to a fresh task after a follow-up failure', async () => {
      const be = makeBackend({ injectStatusLines: false });
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');

      be.write('second');
      await flush();
      resolvers.shift()!(new Response('gone', { status: 410 }));
      await flush();
      // Lineage broken → next message starts a new task instead of failing forever.
      be.write('third');
      await flush();
      expect(calls.filter(c => c.url.includes('/api/task-execute')).length).toBe(2);
    });

    it('ignores a duplicate done event (no double turn-boundary)', () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-1');
      expect(done).toHaveBeenCalledTimes(1);
    });

    it('cross-turn duplicate done: A done → B write → A duplicate done must not fire mid-B', async () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      be.spawn('', [], {} as any);
      be.write('first');
      await flush();
      resolvers.shift()!(taskResponse('task-A'));
      await flush();
      // A completes → boundary fires once, queued follow-up becomes task B.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      expect(done).toHaveBeenCalledTimes(1);
      be.write('second');
      await flush();
      resolvers.shift()!(taskResponse('task-B'));
      await flush();
      expect((be as any).taskDone).toBe(false); // B is running
      // A's duplicate done arrives ~500ms later (observed live): must be inert.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-A');
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(false); // B must not be marked done
      // B's own done still fires the boundary normally.
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed"}', 'task-B');
      expect(done).toHaveBeenCalledTimes(2);
    });
  });

  describe('onTaskDone turn boundary', () => {
    it('fires when the done SSE event arrives', () => {
      const be = makeBackend({ injectStatusLines: false });
      const done = vi.fn();
      be.onTaskDone(done);
      (be as any).currentTaskId = 'task-1';
      (be as any).handleSseEvent('event:done\ndata:{"status":"completed","exitCode":0}', 'task-1');
      expect(done).toHaveBeenCalledTimes(1);
      expect((be as any).taskDone).toBe(true);
    });

    it('fires when task creation fails, so queued follow-ups are not stuck', async () => {
      const be = makeBackend();
      const done = vi.fn();
      be.onTaskDone(done);
      fetchMock.mockImplementation(async () => { throw new Error('network down'); });
      be.write('hello');
      await flush();
      expect(done).toHaveBeenCalledTimes(1);
    });
  });

  describe('repo reuse (复用本地仓库+分支)', () => {
    it('parseRiffRepoName normalizes internal specs and rejects external hosts', () => {
      expect(parseRiffRepoName('git@code.byted.org:webinfra/agent-monorepo.git')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('https://code.byted.org/webinfra/agent-monorepo.git')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('https://code.byted.org/webinfra/agent-monorepo/')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('webinfra/agent-monorepo')).toBe('webinfra/agent-monorepo');
      expect(parseRiffRepoName('git@github.com:deepcoldy/botmux.git')).toBeNull();
      expect(parseRiffRepoName('https://github.com/deepcoldy/botmux')).toBeNull();
      expect(parseRiffRepoName('')).toBeNull();
    });

    it('derives repoName + pinned branch when the branch exists on the remote', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      const derived = deriveRiffRepoFromWorkingDir('/repo', git({
        'remote get-url origin': 'git@code.byted.org:webinfra/agent-monorepo.git',
        'rev-parse --abbrev-ref HEAD': 'feat/x',
        'rev-parse --verify --quiet refs/remotes/origin/feat/x': 'abc123',
        'rev-list --count refs/remotes/origin/feat/x..HEAD': '0',
        'status --porcelain': null,
      }));
      expect(derived).toEqual({ repo: { repoName: 'webinfra/agent-monorepo', repoBranch: 'feat/x' }, warnings: [] });
    });

    it('warns on unpushed branch (falls back to default branch) and dirty tree', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      const derived = deriveRiffRepoFromWorkingDir('/repo', git({
        'remote get-url origin': 'git@code.byted.org:g/r.git',
        'rev-parse --abbrev-ref HEAD': 'local-only',
        'status --porcelain': ' M src/a.ts',
      }));
      expect(derived!.repo).toEqual({ repoName: 'g/r' });
      expect(derived!.warnings.some(w => w.includes('未推送到远端'))).toBe(true);
      expect(derived!.warnings.some(w => w.includes('未提交改动'))).toBe(true);
    });

    it('multi-repo: derives every child worktree under a non-git parent dir', () => {
      const perDir: Record<string, { repo: any; warnings: string[] } | null> = {
        '/parent': null,
        '/parent/a': { repo: { repoName: 'g/a', repoBranch: 'wt/x' }, warnings: [] },
        '/parent/b': { repo: { repoName: 'g/b' }, warnings: ['本地分支 wt/y 未推送到远端，沙箱将使用默认分支'] },
        '/parent/junk': null,
      };
      const derived = deriveRiffReposFromWorkingDir('/parent', {
        deriveOne: (dir: string) => perDir[dir] ?? null,
        listChildDirs: () => ['/parent/a', '/parent/b', '/parent/junk'],
      });
      expect(derived!.repos).toEqual([{ repoName: 'g/a', repoBranch: 'wt/x' }, { repoName: 'g/b' }]);
      expect(derived!.warnings).toEqual(['[g/b] 本地分支 wt/y 未推送到远端，沙箱将使用默认分支']);
    });

    it('multi-repo: direct git workingDir still yields a single repo without child scan', () => {
      const derived = deriveRiffReposFromWorkingDir('/repo', {
        deriveOne: (dir: string) => dir === '/repo' ? { repo: { repoName: 'g/r', repoBranch: 'main' }, warnings: [] } : null,
        listChildDirs: () => { throw new Error('must not scan children'); },
      });
      expect(derived!.repos).toEqual([{ repoName: 'g/r', repoBranch: 'main' }]);
    });

    it('multi-repo: returns null when neither the dir nor its children derive', () => {
      expect(deriveRiffReposFromWorkingDir('/x', { deriveOne: () => null, listChildDirs: () => ['/x/a'] })).toBeNull();
    });

    it('returns null for non-internal origins and non-git dirs', () => {
      const git = (answers: Record<string, string | null>) => (args: string[]) =>
        answers[args.join(' ')] ?? null;
      expect(deriveRiffRepoFromWorkingDir('/repo', git({ 'remote get-url origin': 'git@github.com:a/b.git' }))).toBeNull();
      expect(deriveRiffRepoFromWorkingDir('/repo', git({}))).toBeNull();
    });

    it('sends config.repos in the API-native shape and a status line', async () => {
      const be = makeBackend({ repos: [{ repoName: 'g/r', repoBranch: 'dev' }], repoWarnings: ['本地工作区有未提交改动，沙箱只能看到已推送内容'] });
      const lines: string[] = [];
      be.onData(d => lines.push(d));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      const body = JSON.parse(String(exec.init?.body));
      expect(body.config.repos).toEqual([{ repoName: 'g/r', repoBranch: 'dev' }]);
      expect(lines.join('')).toContain('[riff] 仓库: g/r@dev');
      expect(lines.join('')).toContain('⚠️ 本地工作区有未提交改动');
    });

    it('ignores stale defaultRepo config — repos come only from config.repos', async () => {
      const be = makeBackend({ defaultRepo: 'https://code.byted.org/g/r.git', defaultBranch: 'dev', injectStatusLines: false } as any);
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1'));
      await flush();
      const exec = calls.find(c => c.url.includes('/api/task-execute'))!;
      expect(JSON.parse(String(exec.init?.body)).config.repos).toBeUndefined();
    });
  });

  describe('access URL handling', () => {
    it('rewrites accessUrl origin onto the configured baseUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=abc&folder=%2Fx',
      }));
      await flush();
      expect(urls).toContain(`${BASE}/sandbox-access?sessionId=abc&folder=%2Fx`);
    });

    it('prefers directAccessUrl and never downgrades back to a frontend URL', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      be.spawn('', [], {} as any);
      be.write('hi');
      await flush();
      resolvers.shift()!(taskResponse('task-1', {
        accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=abc',
        directAccessUrl: 'https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx',
      }));
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx');

      // A later frontend-only URL must not replace the direct terminal URL.
      (be as any).updateAccessUrl({ accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=late' });
      expect(urls[urls.length - 1]).toBe('https://port-8080-v1-abc.cn-north.ai-sandbox-boe.byted.org/?folder=%2Fx');
    });

    it('upgrades to directAccessUrl from a task-detail fetch after an SSE accessUrl', async () => {
      const be = makeBackend();
      const urls: string[] = [];
      be.onAccessUrl((u) => urls.push(u));
      (be as any).currentTaskId = 'task-9';
      fetchMock.mockImplementation(async (url: string | URL) => {
        const u = String(url);
        calls.push({ url: u });
        if (u.includes('/api/task-detail')) {
          return Response.json({ success: true, data: { task: {
            accessUrl: 'https://riff.bytedance.net/sandbox-access?sessionId=z',
            directAccessUrl: 'https://port-8080-z.cn-north.ai-sandbox-boe.byted.org/',
          } } });
        }
        return pendingSseResponse();
      });
      // Simulate the SSE init event carrying only the frontend accessUrl.
      (be as any).handleSseEvent('event:init\ndata:{"accessUrl":"https://riff.bytedance.net/sandbox-access?sessionId=z"}', 'task-9');
      expect(urls[urls.length - 1]).toBe(`${BASE}/sandbox-access?sessionId=z`);
      await flush();
      expect(urls[urls.length - 1]).toBe('https://port-8080-z.cn-north.ai-sandbox-boe.byted.org/');
    });
  });
});
