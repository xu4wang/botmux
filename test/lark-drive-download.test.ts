import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseLarkToolInvocation } from '../src/core/lark-tool-command.js';
import {
  downloadProxyRoute, planDriveRangedDownload, runDriveRangedDownload, type DriveRangedDownloadContext,
} from '../src/core/lark-drive-download.js';
import { readLarkToolHelp } from './helpers/lark-tool-help.js';

const binding = { appId: 'cli_current', defaultAs: 'bot' as const };
const parse = (args: string[]) => parseLarkToolInvocation(args, binding, readLarkToolHelp);
const TOKEN = 'boxcnFixtureToken0001';
const PLAN = { fileToken: TOKEN, output: 'out.bin', overwrite: false };
// 11 blocks of 1 KiB (the last one partial) → parts [0-3] [4-7] [8-10].
const SIZE = 10 * 1024 + 300;
const TUNING = {
  thresholdBytes: 0, blockBytes: 1024, partBlocks: 4, concurrency: 3,
  requestTimeoutMs: 5_000, idleTimeoutMs: 2_000, maxAttempts: 3, retryBaseMs: 1,
};

describe('planDriveRangedDownload', () => {
  it('takes over a plain drive +download into a named file', () => {
    expect(parse(['drive', '+download', '--file-token', TOKEN, '--output', './a.mp4']).command).toEqual(['drive', '+download']);
    expect(planDriveRangedDownload(parse(['drive', '+download', '--file-token', TOKEN, '--output', './a.mp4'])))
      .toEqual({ fileToken: TOKEN, output: './a.mp4', overwrite: false });
    expect(planDriveRangedDownload(parse(['drive', '+download', `--file-token=${TOKEN}`, '--output=a.mp4', '--overwrite', '--as', 'user', '--json'])))
      .toEqual({ fileToken: TOKEN, output: 'a.mp4', overwrite: true });
    expect(planDriveRangedDownload(parse(['drive', '+download', '--format', 'json', '--file-token', TOKEN, '--output', 'a.mp4', '--overwrite=false'])))
      .toEqual({ fileToken: TOKEN, output: 'a.mp4', overwrite: false });
  });

  it.each([
    [['drive', '+download', '--file-token', TOKEN]],
    [['drive', '+download', '--file-token', TOKEN, '--output', 'a', '--dry-run']],
    [['drive', '+download', '--file-token', TOKEN, '--output', 'a', '-q', '.data']],
    [['drive', '+download', '--file-token', TOKEN, '--output', 'a', '--format', 'pretty']],
    [['drive', '+download', '--file-token', 'https://x.feishu.cn/file/abc', '--output', 'a']],
    [['drive', '+download', '--file-token', TOKEN, '--output', 'a', '--profile', 'cli_other']],
    [['drive', '+download', '--file-token', TOKEN, '--output', 'a', '--help']],
    [['docs', '+fetch', '--doc', 'doc-1']],
  ])('leaves %j to lark-cli', args => {
    expect(planDriveRangedDownload(parse(args))).toBeUndefined();
  });
});

describe('downloadProxyRoute follows Go ProxyFromEnvironment', () => {
  const target = new URL('https://open.feishu.cn/open-apis/drive/v1/files/x/download');
  const proxyHost = (env: NodeJS.ProcessEnv) => {
    const route = downloadProxyRoute(target, env);
    return route?.kind === 'http' ? route.proxy.host : route?.kind;
  };

  it('reads only the https variable, uppercase first', () => {
    expect(proxyHost({ https_proxy: 'http://127.0.0.1:7890' })).toBe('127.0.0.1:7890');
    expect(proxyHost({ HTTPS_PROXY: 'http://a:1', https_proxy: 'http://b:2' })).toBe('a:1');
    expect(proxyHost({ https_proxy: '127.0.0.1:7890' })).toBe('127.0.0.1:7890');
    expect(proxyHost({ http_proxy: 'http://127.0.0.1:7890', all_proxy: 'socks5h://127.0.0.1:7890' })).toBe('direct');
  });

  it('honours NO_PROXY and loopback', () => {
    for (const no_proxy of ['*', 'feishu.cn', '.feishu.cn', 'open.feishu.cn:443', 'example.com, open.feishu.cn']) {
      expect(proxyHost({ https_proxy: 'http://p:1', no_proxy })).toBe('direct');
    }
    expect(proxyHost({ https_proxy: 'http://p:1', no_proxy: 'open.feishu.cn:8443,feishu.com' })).toBe('p:1');
    expect(downloadProxyRoute(new URL('http://127.0.0.1:9/x'), { http_proxy: 'http://p:1' })).toEqual({ kind: 'direct' });
  });

  it('declines proxies it cannot speak', () => {
    expect(downloadProxyRoute(target, { https_proxy: 'socks5h://127.0.0.1:7890' })).toBeUndefined();
    expect(downloadProxyRoute(target, { https_proxy: 'https://proxy:443' })).toBeUndefined();
  });
});

type Verdict = 'ok' | 'reset' | 'forbidden' | 'rate';

interface FakeDrive {
  data: Buffer;
  /** Range header of every request, in arrival order (the probe is first). */
  ranges: string[];
  origin: string;
  accepted: string;
  acceptRanges: boolean;
  verdict: (start: number, end: number) => Verdict;
  close(): Promise<void>;
}

async function startFakeDrive(size = SIZE): Promise<FakeDrive> {
  const drive = {
    data: randomBytes(size), ranges: [] as string[], origin: '', accepted: 'cred-1', acceptRanges: true,
    verdict: (() => 'ok') as FakeDrive['verdict'],
  } as FakeDrive;
  const server: Server = createServer((req, res) => {
    drive.ranges.push(String(req.headers.range));
    const json = (status: number, code: number, msg: string) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, msg }));
    };
    if (req.url !== `/open-apis/drive/v1/files/${TOKEN}/download`) return json(404, 1061003, 'not found');
    if (req.headers.authorization !== `Bearer ${drive.accepted}`) return json(400, 99991663, 'Invalid access token');
    const match = /^bytes=(\d+)-(\d+)$/.exec(String(req.headers.range));
    if (!match || !drive.acceptRanges) {
      res.writeHead(200, { 'content-length': drive.data.length });
      res.end(drive.data);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]), drive.data.length - 1);
    const verdict = drive.verdict(start, end);
    if (verdict === 'forbidden') return json(403, 1061004, 'forbidden');
    if (verdict === 'rate') return json(429, 99991400, 'request trigger frequency limit');
    res.writeHead(206, { 'content-range': `bytes ${start}-${end}/${drive.data.length}`, 'content-length': end - start + 1 });
    if (verdict === 'reset') {
      // Half the body, then a dropped connection — the shape of the platform's mid-stream reset.
      res.write(drive.data.subarray(start, start + Math.floor((end - start + 1) / 2)));
      setImmediate(() => res.socket?.destroy());
      return;
    }
    res.end(drive.data.subarray(start, end + 1));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  drive.origin = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  drive.close = () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); });
  return drive;
}

let dir: string;
let drive: FakeDrive;
beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'lark-drive-download-')));
  drive = await startFakeDrive();
});
afterEach(async () => {
  await drive.close();
  rmSync(dir, { recursive: true, force: true });
});

function context(extra: Partial<DriveRangedDownloadContext> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const refreshes: string[] = [];
  const ctx: DriveRangedDownloadContext = {
    brand: 'feishu', mode: 'bot', credential: 'cred-1',
    refreshCredential: async () => { refreshes.push('cred-2'); return 'cred-2'; },
    env: {}, cwd: dir, origin: drive.origin,
    stdout: text => { out.push(text); }, stderr: text => { err.push(text); },
    tuning: TUNING,
    ...extra,
  };
  return { ctx, out, err, refreshes };
}

const partFile = () => join(dir, '.out.bin.botmux-part');
const stateFile = () => `${partFile()}.json`;
const dataRanges = () => drive.ranges.slice(1).sort();

describe('runDriveRangedDownload', () => {
  it('downloads a large file in Range parts and reports like lark-cli', async () => {
    const { ctx, out, err } = context();
    expect(await runDriveRangedDownload(PLAN, ctx)).toBe(0);
    expect(readFileSync(join(dir, 'out.bin')).equals(drive.data)).toBe(true);
    expect(existsSync(partFile()) || existsSync(stateFile())).toBe(false);
    expect(JSON.parse(out.join(''))).toEqual({ ok: true, identity: 'bot', data: { saved_path: join(dir, 'out.bin'), size_bytes: SIZE } });
    expect(err.join('')).toContain('ranged');
    expect(drive.ranges[0]).toBe('bytes=0-0');
    expect(dataRanges()).toEqual(['bytes=0-4095', 'bytes=4096-8191', 'bytes=8192-10539']);
  });

  it('retries a dropped part, then splits it into single blocks', async () => {
    let rateLimited = false;
    drive.verdict = (start, end) => {
      if (start === 0 && end === 4095 && !rateLimited) { rateLimited = true; return 'rate'; }
      return start === 4096 && end === 8191 ? 'reset' : 'ok';
    };
    const { ctx } = context();
    expect(await runDriveRangedDownload(PLAN, ctx)).toBe(0);
    expect(readFileSync(join(dir, 'out.bin')).equals(drive.data)).toBe(true);
    expect(drive.ranges.filter(r => r === 'bytes=4096-8191')).toHaveLength(2);
    for (const block of ['bytes=4096-5119', 'bytes=5120-6143', 'bytes=6144-7167', 'bytes=7168-8191']) {
      expect(drive.ranges).toContain(block);
    }
  });

  it('gives up on a block that keeps failing, then resumes only the missing bytes', async () => {
    drive.verdict = start => (start === 8192 ? 'reset' : 'ok');
    const first = context();
    expect(await runDriveRangedDownload(PLAN, first.ctx)).toBe(4);
    const error = JSON.parse(first.err.join('').slice(first.err.join('').indexOf('{')));
    expect(error).toMatchObject({ ok: false, identity: 'bot', error: { type: 'network' } });
    expect(error.error.message).toContain('run the same command again to resume');
    expect(existsSync(join(dir, 'out.bin'))).toBe(false);
    const state = JSON.parse(readFileSync(stateFile(), 'utf8'));
    expect(state.done).toEqual(expect.arrayContaining([0, 1, 2, 3, 4, 5, 6, 7]));
    expect(state.done).not.toContain(8);

    drive.verdict = () => 'ok';
    drive.ranges.length = 0;
    const second = context();
    expect(await runDriveRangedDownload(PLAN, second.ctx)).toBe(0);
    expect(readFileSync(join(dir, 'out.bin')).equals(drive.data)).toBe(true);
    expect(second.err.join('')).toContain('resuming');
    // Nothing below the failed block is fetched again (the probe aside).
    expect(dataRanges().every(r => Number(/^bytes=(\d+)/.exec(r)![1]) >= 8192)).toBe(true);
  });

  it('refreshes an expired credential once and carries on', async () => {
    drive.verdict = () => { drive.accepted = 'cred-2'; return 'ok'; }; // expires right after the probe
    const { ctx, refreshes } = context();
    expect(await runDriveRangedDownload(PLAN, ctx)).toBe(0);
    expect(readFileSync(join(dir, 'out.bin')).equals(drive.data)).toBe(true);
    expect(refreshes).toHaveLength(1);
  });

  it('stops on the runner signal with progress saved, and the rerun completes', async () => {
    const abort = new AbortController();
    drive.verdict = start => {
      if (start === 4096) abort.abort('SIGINT');
      return 'ok';
    };
    const first = context({ signal: abort.signal, tuning: { ...TUNING, concurrency: 1 } });
    expect(await runDriveRangedDownload(PLAN, first.ctx)).toBe(130);
    expect(existsSync(stateFile())).toBe(true);
    expect(existsSync(join(dir, 'out.bin'))).toBe(false);

    drive.verdict = () => 'ok';
    const second = context();
    expect(await runDriveRangedDownload(PLAN, second.ctx)).toBe(0);
    expect(readFileSync(join(dir, 'out.bin')).equals(drive.data)).toBe(true);
  });

  it('reports a refused download as an API error', async () => {
    drive.verdict = (start, end) => (end > 0 ? 'forbidden' : 'ok');
    const { ctx, err } = context();
    expect(await runDriveRangedDownload(PLAN, ctx)).toBe(4);
    expect(err.join('')).toContain('HTTP 403 code 1061004');
  });

  it('replaces an existing output only with --overwrite', async () => {
    writeFileSync(join(dir, 'out.bin'), 'old');
    expect(await runDriveRangedDownload(PLAN, context().ctx)).toBe('delegate');
    expect(drive.ranges).toEqual([]);
    expect(await runDriveRangedDownload({ ...PLAN, overwrite: true }, context().ctx)).toBe(0);
    expect(readFileSync(join(dir, 'out.bin')).equals(drive.data)).toBe(true);
  });

  it('leaves small files and Range-less servers to lark-cli after one probe', async () => {
    expect(await runDriveRangedDownload(PLAN, context({ tuning: { ...TUNING, thresholdBytes: SIZE } }).ctx)).toBe('delegate');
    expect(drive.ranges).toEqual(['bytes=0-0']);
    drive.acceptRanges = false;
    expect(await runDriveRangedDownload(PLAN, context().ctx)).toBe('delegate');
    expect(existsSync(partFile())).toBe(false);
  });

  it('keeps lark-cli in charge of out-of-tree paths and unsupported proxies', async () => {
    mkdirSync(join(dir, 'work'));
    const outside = mkdtempSync(join(tmpdir(), 'lark-drive-outside-'));
    symlinkSync(outside, join(dir, 'work', 'link'));
    try {
      const cwd = join(dir, 'work');
      for (const output of [join(dir, 'abs.bin'), '../escape.bin', 'link/inside-link.bin', 'missing-dir/out.bin']) {
        expect(await runDriveRangedDownload({ ...PLAN, output }, context({ cwd }).ctx)).toBe('delegate');
      }
      // Loopback never uses a proxy, so point the socks case at a non-loopback origin.
      const socks = context({ env: { HTTP_PROXY: 'socks5h://127.0.0.1:1' }, origin: 'http://drive.invalid' });
      expect(await runDriveRangedDownload(PLAN, socks.ctx)).toBe('delegate');
      expect(drive.ranges).toEqual([]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
