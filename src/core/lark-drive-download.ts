/**
 * Ranged download for `lark-cli drive +download`, run inside the managed
 * lark-cli runner (`src/lark-tool-runner.ts`).
 *
 * Why it lives here: the Open Platform resets a single file-download request
 * after roughly 300 s — HTTP/2 RST_STREAM INTERNAL_ERROR "received from peer",
 * reproduced at 5:06–5:12 wall clock both through HTTPS_PROXY and direct. At
 * ordinary throughput a multi-GB drive file therefore never finishes, and
 * lark-cli (checked through 1.0.98) neither resumes nor sends Range for drive
 * files, while `lark-cli api` cannot set request headers. The runner already
 * holds this invocation's short-lived credential, so it can fetch the file in
 * bounded Range requests without the credential ever reaching the agent.
 *
 * The takeover is deliberately narrow. It only considers
 * `drive +download --file-token <token> --output <relative file>` (plus
 * `--overwrite`, `--format json` / `--json`), and only after the server itself
 * answers a one-byte probe with 206 + Content-Range for a file above the
 * threshold. Everything else — small files, wiki tokens, dry runs, jq/format
 * options, an output that exists without --overwrite, servers that ignore
 * Range, redirects, proxies we cannot speak — returns 'delegate' and runs
 * through the real lark-cli exactly as before.
 *
 * Mirrored lark-cli contracts: --output must stay inside the working
 * directory; the result JSON goes to stdout and errors to stderr; the file is
 * created 0600. The proxy is chosen the way lark-cli (Go's
 * ProxyFromEnvironment) chooses it — HTTPS_PROXY / https_proxy for https,
 * NO_PROXY honoured, no ALL_PROXY or HTTP_PROXY fallback — so the bytes leave
 * the machine the same way lark-cli's own request would. node:http(s) is used
 * instead of fetch for the reasons recorded in core/release-download.ts.
 *
 * Progress is kept beside the output (`.<name>.botmux-part` plus a `.json`
 * block list), so rerunning the same command resumes instead of restarting.
 */
import { Buffer } from 'node:buffer';
import { lstat, open, readFile, realpath, rename, rm, type FileHandle } from 'node:fs/promises';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { larkHosts, type Brand } from '../im/lark/lark-hosts.js';
import type { LarkToolInvocation } from './lark-tool-command.js';

export interface DriveRangedDownloadPlan {
  fileToken: string;
  output: string;
  overwrite: boolean;
}

export interface RangedDownloadTuning {
  /** Files at or below this size go to lark-cli unchanged. */
  thresholdBytes: number;
  /** Resume granularity, and the size a stuck request is split into. */
  blockBytes: number;
  /** Blocks per ordinary request (64 MiB with the defaults). */
  partBlocks: number;
  concurrency: number;
  /** Hard cap per request, well under the server's ~300 s reset. */
  requestTimeoutMs: number;
  /** Abort a request that delivers no bytes for this long. */
  idleTimeoutMs: number;
  /** Failures of a single-block request before the download gives up. */
  maxAttempts: number;
  retryBaseMs: number;
}

export const RANGED_DOWNLOAD_DEFAULTS: Readonly<RangedDownloadTuning> = Object.freeze({
  thresholdBytes: 256 * 1024 * 1024,
  blockBytes: 8 * 1024 * 1024,
  partBlocks: 8,
  concurrency: 4,
  requestTimeoutMs: 180_000,
  idleTimeoutMs: 60_000,
  maxAttempts: 6,
  retryBaseMs: 1_000,
});

export interface DriveRangedDownloadContext {
  brand: Brand;
  mode: 'bot' | 'user';
  credential: string;
  /** Mint a fresh credential through the daemon (expired-token recovery). */
  refreshCredential: () => Promise<string>;
  env: NodeJS.ProcessEnv;
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Aborted with the signal name ('SIGINT' / 'SIGTERM') by the runner. */
  signal?: AbortSignal;
  /** Test seam: replaces the brand's Open Platform origin. */
  origin?: string;
  tuning?: Partial<RangedDownloadTuning>;
}

const VALUE_FLAGS = new Set(['--file-token', '--output', '--format']);
const BOOLEAN_FLAGS = new Set(['--overwrite', '--json']);
const PROBE_TIMEOUT_MS = 30_000;
const MAX_CREDENTIAL_REFRESHES = 3;
const MAX_RATE_LIMIT_WAITS = 30;
const USER_AGENT = 'botmux-lark-tool-runner';
// Feishu/Lark Open Platform codes for a missing/invalid/expired access token,
// and for the per-app rate limit.
const AUTH_CODES = new Set([99991661, 99991663, 99991664, 99991665, 99991668, 99991677]);
const RATE_LIMIT_CODES = new Set([99991400]);

/** Recognise the one invocation shape the runner may take over. Anything not
 *  fully understood here stays with lark-cli. */
export function planDriveRangedDownload(invocation: LarkToolInvocation): DriveRangedDownloadPlan | undefined {
  if (invocation.offline || invocation.showHelp || invocation.passthroughProfile || invocation.literalIndex >= 0) return undefined;
  if (invocation.command.join(' ') !== 'drive +download') return undefined;
  const values = new Map<string, string>();
  const positionals: string[] = [];
  let overwrite = false;
  const args = invocation.args;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-') || arg === '-') { positionals.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const inline = eq < 0 ? undefined : arg.slice(eq + 1);
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || values.has(name)) return undefined;
      values.set(name, value);
    } else if (BOOLEAN_FLAGS.has(name)) {
      const on = inline === undefined || inline === 'true' ? true : inline === 'false' ? false : undefined;
      if (on === undefined) return undefined;
      if (name === '--overwrite') overwrite = on;
      else if (!on) return undefined;
    } else {
      return undefined;
    }
  }
  const fileToken = values.get('--file-token');
  const output = values.get('--output');
  const format = values.get('--format');
  if (positionals.join(' ') !== 'drive +download' || !fileToken || !output) return undefined;
  if (format !== undefined && format !== 'json') return undefined;
  // Plain drive tokens only; URLs and other forms keep lark-cli's own resolution.
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(fileToken)) return undefined;
  return { fileToken, output, overwrite };
}

export type DownloadProxyRoute = { kind: 'direct' } | { kind: 'http'; proxy: URL };

/** Go's ProxyFromEnvironment, which lark-cli uses: only the scheme's own
 *  variable (uppercase first), NO_PROXY and loopback honoured. `undefined`
 *  means a proxy this module cannot speak (e.g. socks5://), so the caller
 *  leaves the download to lark-cli. */
export function downloadProxyRoute(target: URL, env: NodeJS.ProcessEnv): DownloadProxyRoute | undefined {
  const raw = target.protocol === 'https:'
    ? env.HTTPS_PROXY || env.https_proxy
    : env.HTTP_PROXY || env.http_proxy;
  if (!raw || bypassesProxy(target, env.NO_PROXY || env.no_proxy || '')) return { kind: 'direct' };
  let proxy: URL;
  try {
    proxy = new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`);
  } catch {
    return undefined;
  }
  return proxy.protocol === 'http:' && proxy.hostname ? { kind: 'http', proxy } : undefined;
}

function bypassesProxy(target: URL, noProxy: string): boolean {
  const host = target.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host === '::1' || /^127\./.test(host)) return true;
  const port = target.port || (target.protocol === 'https:' ? '443' : '80');
  for (const rawEntry of noProxy.split(',')) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    const withPort = /^([^:]+):(\d+)$/.exec(entry);
    if (withPort) {
      if (withPort[2] !== port) continue;
      entry = withPort[1];
    }
    entry = entry.replace(/^\*?\./, '');
    if (host === entry || host.endsWith(`.${entry}`)) return true;
  }
  return false;
}

/**
 * Take over a planned `drive +download` when the server confirms a large,
 * Range-capable file. Returns 'delegate' (run lark-cli as usual) or the exit
 * code of a download this function handled itself.
 */
export async function runDriveRangedDownload(
  plan: DriveRangedDownloadPlan,
  ctx: DriveRangedDownloadContext,
): Promise<'delegate' | number> {
  const tuning: RangedDownloadTuning = { ...RANGED_DOWNLOAD_DEFAULTS, ...ctx.tuning };
  const outPath = await resolveOutputPath(ctx.cwd, plan.output);
  if (!outPath) return 'delegate';
  const existing = await lstat(outPath).catch(() => undefined);
  // lark-cli owns every error message for an existing output.
  if (existing && (!existing.isFile() || !plan.overwrite)) return 'delegate';
  const url = new URL(
    `/open-apis/drive/v1/files/${encodeURIComponent(plan.fileToken)}/download`,
    ctx.origin ?? larkHosts(ctx.brand).openApi,
  );
  const route = downloadProxyRoute(url, ctx.env);
  if (!route) return 'delegate';
  const total = await probeSize(url, route, ctx.credential, ctx.signal);
  if (ctx.signal?.aborted) return abortExitCode(ctx.signal);
  if (total === undefined || total <= tuning.thresholdBytes) return 'delegate';
  return downloadInRanges({ plan, ctx, tuning, url, route, total, outPath });
}

/** lark-cli only writes inside the working directory; keep that boundary,
 *  symlinked parents included. `undefined` hands the path back to lark-cli. */
async function resolveOutputPath(cwd: string, output: string): Promise<string | undefined> {
  if (isAbsolute(output)) return undefined;
  const target = resolve(cwd, output);
  if (!isWithin(cwd, target, false)) return undefined;
  try {
    const parent = await realpath(dirname(target));
    if (!isWithin(await realpath(cwd), parent, true)) return undefined;
    return join(parent, basename(target));
  } catch {
    return undefined;
  }
}

function isWithin(root: string, path: string, allowRoot: boolean): boolean {
  const rel = relative(root, path);
  if (rel === '') return allowRoot;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function probeSize(
  url: URL,
  route: DownloadProxyRoute,
  credential: string,
  signal: AbortSignal | undefined,
): Promise<number | undefined> {
  const abort = new AbortController();
  const onAbort = () => abort.abort(signal?.reason);
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => abort.abort(new Error('probe timed out')), PROBE_TIMEOUT_MS);
  try {
    const res = await openGet(url, { authorization: `Bearer ${credential}`, range: 'bytes=0-0' }, route, abort.signal);
    const match = /^bytes 0-0\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
    res.destroy();
    if (res.statusCode !== 206 || !match) return undefined;
    const total = Number(match[1]);
    return Number.isSafeInteger(total) && total > 0 ? total : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    abort.abort();
  }
}

interface DownloadJob {
  plan: DriveRangedDownloadPlan;
  ctx: DriveRangedDownloadContext;
  tuning: RangedDownloadTuning;
  url: URL;
  route: DownloadProxyRoute;
  total: number;
  outPath: string;
}

interface Part { first: number; last: number; attempts: number }

type RangeOutcome =
  | { ok: true }
  | { ok: false; kind: 'retry' | 'auth' | 'rate' | 'fatal' | 'local' | 'aborted'; message: string };

class LocalWriteError extends Error {}

async function downloadInRanges(job: DownloadJob): Promise<number> {
  const { plan, ctx, tuning, total, outPath } = job;
  const partPath = join(dirname(outPath), `.${basename(outPath)}.botmux-part`);
  const statePath = `${partPath}.json`;
  const blockCount = Math.ceil(total / tuning.blockBytes);
  const blockLength = (index: number) => Math.min(tuning.blockBytes, total - index * tuning.blockBytes);
  const done = new Uint8Array(blockCount);
  const resumed = await loadState(statePath, partPath, plan.fileToken, total, tuning.blockBytes);
  let file: FileHandle;
  try {
    if (resumed) {
      for (const index of resumed) done[index] = 1;
      file = await open(partPath, 'r+');
    } else {
      await rm(partPath, { force: true });
      file = await open(partPath, 'wx', 0o600);
      await file.truncate(total);
    }
  } catch (error) {
    ctx.stderr(errorJson(ctx.mode, 'internal', 'file_io', `cannot create file: ${messageOf(error)}`));
    return 5;
  }
  const saveState = () => {
    const indices: number[] = [];
    for (let i = 0; i < blockCount; i++) if (done[i]) indices.push(i);
    atomicWriteFileSync(statePath, JSON.stringify({
      version: 1, fileToken: plan.fileToken, total, blockBytes: tuning.blockBytes, done: indices,
    }), { mode: 0o600, followTargetSymlink: false });
  };
  let savedBytes = 0;
  for (let i = 0; i < blockCount; i++) if (done[i]) savedBytes += blockLength(i);
  try {
    if (!resumed) saveState();
  } catch (error) {
    await file.close().catch(() => {});
    ctx.stderr(errorJson(ctx.mode, 'internal', 'file_io', `cannot save progress: ${messageOf(error)}`));
    return 5;
  }
  ctx.stderr(`Downloading: ${maskToken(plan.fileToken)} (${formatBytes(total)}, ranged`
    + `${savedBytes ? `, resuming with ${formatBytes(savedBytes)} saved` : ''})\n`);

  // One controller for the whole job: the runner's signal or a fatal error
  // cancels every in-flight request instead of waiting out its timeout.
  const jobAbort = new AbortController();
  const onOuterAbort = () => jobAbort.abort(ctx.signal?.reason);
  if (ctx.signal?.aborted) onOuterAbort();
  else ctx.signal?.addEventListener('abort', onOuterAbort, { once: true });

  const queue = pendingParts(done, tuning.partBlocks);
  let credential = ctx.credential;
  let refreshing: Promise<void> | undefined;
  let refreshes = 0;
  let rateWaits = 0;
  let inFlight = 0;
  let failure: { code: number; type: string; subtype: string; message: string } | undefined;
  let milestone = Math.floor((savedBytes / total) * 4);
  const fail = (code: number, type: string, subtype: string, message: string) => {
    if (!failure) failure = { code, type, subtype, message };
    jobAbort.abort(new Error(message));
  };
  const refresh = async (seen: string) => {
    if (credential !== seen) return;
    refreshing ??= (async () => {
      refreshes++;
      credential = await ctx.refreshCredential();
    })().finally(() => { refreshing = undefined; });
    await refreshing;
  };

  const worker = async () => {
    for (;;) {
      if (jobAbort.signal.aborted) return;
      const part = queue.shift();
      if (!part) {
        if (inFlight === 0) return;
        await sleep(50, jobAbort.signal);
        continue;
      }
      inFlight++;
      try {
        const start = part.first * tuning.blockBytes;
        const end = Math.min((part.last + 1) * tuning.blockBytes, total) - 1;
        const seen = credential;
        const outcome = await fetchRange(job, file, seen, start, end, jobAbort.signal);
        if (outcome.ok) {
          for (let i = part.first; i <= part.last; i++) {
            if (!done[i]) savedBytes += blockLength(i);
            done[i] = 1;
          }
          saveState();
          const reached = Math.floor((savedBytes / total) * 4);
          if (reached > milestone && reached < 4) ctx.stderr(`Downloaded ${reached * 25}% (${formatBytes(savedBytes)} of ${formatBytes(total)})\n`);
          milestone = Math.max(milestone, reached);
          continue;
        }
        if (outcome.kind === 'aborted') return;
        if (outcome.kind === 'local') { fail(5, 'internal', 'file_io', outcome.message); return; }
        if (outcome.kind === 'fatal') { fail(4, 'api', 'download', outcome.message); return; }
        if (outcome.kind === 'auth') {
          if (refreshes >= MAX_CREDENTIAL_REFRESHES) { fail(4, 'api', 'download', outcome.message); return; }
          try { await refresh(seen); } catch (error) { fail(4, 'api', 'download', `credential refresh failed: ${messageOf(error)}`); return; }
          queue.unshift(part);
          continue;
        }
        if (outcome.kind === 'rate') {
          if (++rateWaits > MAX_RATE_LIMIT_WAITS) { fail(4, 'api', 'download', outcome.message); return; }
          await sleep(Math.min(30_000, tuning.retryBaseMs * 2 ** Math.min(rateWaits, 5)), jobAbort.signal);
          queue.unshift(part);
          continue;
        }
        part.attempts++;
        if (part.last > part.first && part.attempts >= 2) {
          // A part that keeps failing is split into single blocks, each its own request.
          const blocks: Part[] = [];
          for (let i = part.first; i <= part.last; i++) blocks.push({ first: i, last: i, attempts: 0 });
          queue.unshift(...blocks);
        } else if (part.attempts >= tuning.maxAttempts) {
          fail(4, 'network', 'transport', `bytes ${start}-${end} failed ${part.attempts} times: ${outcome.message}`);
          return;
        } else {
          await sleep(Math.min(30_000, tuning.retryBaseMs * 2 ** (part.attempts - 1)), jobAbort.signal);
          queue.unshift(part);
        }
      } catch (error) {
        fail(5, 'internal', 'file_io', `cannot save progress: ${messageOf(error)}`);
        return;
      } finally {
        inFlight--;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(tuning.concurrency, queue.length)) }, worker));
  ctx.signal?.removeEventListener('abort', onOuterAbort);
  const interrupted = !failure && ctx.signal?.aborted;
  if (!failure && !interrupted && done.includes(0)) {
    failure = { code: 5, type: 'internal', subtype: 'file_io', message: `block ${done.indexOf(0)} was never written` };
  }
  try { saveState(); } catch { /* best effort: the last per-part save already landed */ }
  if (failure || interrupted) {
    await file.close().catch(() => {});
    if (interrupted) {
      ctx.stderr('Interrupted; progress saved. Run the same command again to resume.\n');
      return abortExitCode(ctx.signal!);
    }
    ctx.stderr(errorJson(ctx.mode, failure!.type, failure!.subtype,
      `${failure!.message} (progress saved; run the same command again to resume)`));
    return failure!.code;
  }
  try {
    await file.sync();
    await file.close();
    const written = await lstat(partPath);
    if (written.size !== total) throw new Error(`assembled ${written.size} bytes, expected ${total}`);
    if (!plan.overwrite && await lstat(outPath).then(() => true, () => false)) {
      ctx.stderr(errorJson(ctx.mode, 'validation', 'invalid_argument',
        `output file already exists: ${plan.output} (use --overwrite to replace)`));
      return 2;
    }
    await rename(partPath, outPath);
    await rm(statePath, { force: true });
  } catch (error) {
    ctx.stderr(errorJson(ctx.mode, 'internal', 'file_io', `cannot finish file: ${messageOf(error)}`));
    return 5;
  }
  ctx.stdout(`${JSON.stringify({ ok: true, identity: ctx.mode, data: { saved_path: outPath, size_bytes: total } }, null, 2)}\n`);
  return 0;
}

async function fetchRange(
  job: DownloadJob,
  file: FileHandle,
  credential: string,
  start: number,
  end: number,
  jobSignal: AbortSignal,
): Promise<RangeOutcome> {
  const { tuning } = job;
  const abort = new AbortController();
  const onJobAbort = () => abort.abort(jobSignal.reason);
  if (jobSignal.aborted) return { ok: false, kind: 'aborted', message: 'aborted' };
  jobSignal.addEventListener('abort', onJobAbort, { once: true });
  const hardTimer = setTimeout(
    () => abort.abort(new Error(`no complete response within ${tuning.requestTimeoutMs / 1000}s`)),
    tuning.requestTimeoutMs,
  );
  let idleTimer: NodeJS.Timeout | undefined;
  const touch = () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => abort.abort(new Error(`stalled for ${tuning.idleTimeoutMs / 1000}s`)), tuning.idleTimeoutMs);
  };
  touch();
  try {
    const res = await openGet(job.url, { authorization: `Bearer ${credential}`, range: `bytes=${start}-${end}` }, job.route, abort.signal);
    if (res.statusCode !== 206) return classifyFailure(res.statusCode ?? 0, await readSmallBody(res));
    const expected = `bytes ${start}-${end}/${job.total}`;
    const received = String(res.headers['content-range'] ?? '');
    if (received !== expected) {
      res.destroy();
      return { ok: false, kind: 'retry', message: `unexpected Content-Range "${received}" (wanted "${expected}")` };
    }
    let position = start;
    for await (const chunk of res as AsyncIterable<Buffer>) {
      touch();
      if (position + chunk.length > end + 1) {
        res.destroy();
        return { ok: false, kind: 'retry', message: 'server sent more bytes than requested' };
      }
      try {
        await file.write(chunk, 0, chunk.length, position);
      } catch (error) {
        throw new LocalWriteError(messageOf(error));
      }
      position += chunk.length;
    }
    if (position !== end + 1) {
      return { ok: false, kind: 'retry', message: `short body: ${position - start} of ${end - start + 1} bytes` };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof LocalWriteError) return { ok: false, kind: 'local', message: `cannot write file: ${error.message}` };
    if (jobSignal.aborted) return { ok: false, kind: 'aborted', message: 'aborted' };
    return { ok: false, kind: 'retry', message: messageOf(abort.signal.aborted ? abort.signal.reason : error) };
  } finally {
    clearTimeout(hardTimer);
    clearTimeout(idleTimer);
    jobSignal.removeEventListener('abort', onJobAbort);
    abort.abort(); // releases the request's sockets on every path
  }
}

function classifyFailure(status: number, body: string): RangeOutcome {
  let code: number | undefined;
  let msg = '';
  try {
    const parsed = JSON.parse(body) as { code?: unknown; msg?: unknown };
    if (typeof parsed.code === 'number') code = parsed.code;
    if (typeof parsed.msg === 'string') msg = parsed.msg;
  } catch { /* not a JSON error body */ }
  const message = `HTTP ${status}${code === undefined ? '' : ` code ${code}`}${msg ? `: ${msg}` : ''}`;
  if (status === 401 || (code !== undefined && AUTH_CODES.has(code))) return { ok: false, kind: 'auth', message };
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) return { ok: false, kind: 'rate', message };
  if (status >= 500 || status === 408 || status === 200) return { ok: false, kind: 'retry', message };
  return { ok: false, kind: 'fatal', message };
}

async function readSmallBody(res: IncomingMessage, limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of res as AsyncIterable<Buffer>) {
      size += chunk.length;
      if (size > limit) break;
      chunks.push(chunk);
    }
  } catch { /* a truncated error body is still classified by status */ }
  res.destroy();
  return Buffer.concat(chunks).toString('utf8');
}

/** GET without following redirects, through the chosen route. Aborting the
 *  signal tears down every socket the request opened, CONNECT tunnel included. */
function openGet(
  url: URL,
  headers: Record<string, string>,
  route: DownloadProxyRoute,
  signal: AbortSignal,
): Promise<IncomingMessage> {
  return new Promise((resolvePromise, reject) => {
    const owned: Array<{ destroy(): unknown }> = [];
    const teardown = () => { for (const item of owned) item.destroy(); };
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      teardown();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onAbort = () => fail(signal.reason ?? new Error('aborted'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    const onResponse = (res: IncomingMessage) => {
      if (settled) { res.destroy(); return; }
      settled = true;
      signal.removeEventListener('abort', onAbort);
      owned.push(res);
      const onLateAbort = () => teardown();
      signal.addEventListener('abort', onLateAbort, { once: true });
      res.once('close', () => { signal.removeEventListener('abort', onLateAbort); teardown(); });
      resolvePromise(res);
    };
    const requestHeaders = { host: url.host, 'user-agent': USER_AGENT, ...headers };
    const path = `${url.pathname}${url.search}`;

    if (route.kind === 'http' && url.protocol === 'https:') {
      // HTTPS through an HTTP proxy: CONNECT tunnel, then TLS over that socket.
      const port = url.port || '443';
      const authority = `${url.hostname}:${port}`;
      const connectReq = httpRequest({
        host: proxyHost(route.proxy), port: Number(route.proxy.port || 80), method: 'CONNECT', path: authority,
        headers: { host: authority, ...proxyAuthorization(route.proxy) },
      });
      owned.push(connectReq);
      connectReq.on('error', fail);
      connectReq.once('connect', (connectRes, socket) => {
        owned.push(socket);
        socket.on('error', fail);
        if (connectRes.statusCode !== 200) { fail(new Error(`proxy CONNECT failed: HTTP ${connectRes.statusCode}`)); return; }
        const tls = tlsConnect({ socket, servername: url.hostname, ALPNProtocols: ['http/1.1'] });
        owned.push(tls);
        tls.on('error', fail);
        tls.once('secureConnect', () => {
          const req = httpsRequest({
            method: 'GET', host: url.hostname, port, path, headers: requestHeaders, createConnection: () => tls,
          }, onResponse);
          owned.push(req);
          req.on('error', fail);
          req.end();
        });
      });
      connectReq.end();
      return;
    }
    if (route.kind === 'http') {
      // Plain-HTTP target through the proxy: absolute-form request line.
      const req = httpRequest({
        host: proxyHost(route.proxy), port: Number(route.proxy.port || 80), method: 'GET', path: url.toString(),
        headers: { ...requestHeaders, ...proxyAuthorization(route.proxy) }, agent: false,
      }, onResponse);
      owned.push(req);
      req.on('error', fail);
      req.end();
      return;
    }
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(url, { method: 'GET', headers: requestHeaders, agent: false }, onResponse);
    owned.push(req);
    req.on('error', fail);
    req.end();
  });
}

/** URL keeps IPv6 brackets in hostname; node:http wants the bare address. */
function proxyHost(proxy: URL): string {
  return proxy.hostname.replace(/^\[|\]$/g, '');
}

function proxyAuthorization(proxy: URL): Record<string, string> {
  if (!proxy.username) return {};
  const credentials = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return { 'proxy-authorization': `Basic ${Buffer.from(credentials).toString('base64')}` };
}

async function loadState(
  statePath: string,
  partPath: string,
  fileToken: string,
  total: number,
  blockBytes: number,
): Promise<number[] | undefined> {
  try {
    const state = JSON.parse(await readFile(statePath, 'utf8')) as {
      version?: unknown; fileToken?: unknown; total?: unknown; blockBytes?: unknown; done?: unknown;
    };
    if (state.version !== 1 || state.fileToken !== fileToken || state.total !== total
      || state.blockBytes !== blockBytes || !Array.isArray(state.done)) return undefined;
    const part = await lstat(partPath);
    if (!part.isFile() || part.size !== total) return undefined;
    const blockCount = Math.ceil(total / blockBytes);
    return state.done.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < blockCount);
  } catch {
    return undefined;
  }
}

function pendingParts(done: Uint8Array, partBlocks: number): Part[] {
  const parts: Part[] = [];
  let i = 0;
  while (i < done.length) {
    if (done[i]) { i++; continue; }
    const first = i;
    while (i < done.length && !done[i] && i - first < partBlocks) i++;
    parts.push({ first, last: i - 1, attempts: 0 });
  }
  return parts;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolveSleep => {
    if (signal.aborted) { resolveSleep(); return; }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolveSleep();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function abortExitCode(signal: AbortSignal): number {
  return signal.reason === 'SIGINT' ? 130 : 143;
}

function errorJson(identity: string, type: string, subtype: string, message: string): string {
  return `${JSON.stringify({ ok: false, identity, error: { type, subtype, message } }, null, 2)}\n`;
}

function maskToken(token: string): string {
  return token.length > 8 ? `${token.slice(0, 4)}...${token.slice(-4)}` : token;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${bytes} B`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
