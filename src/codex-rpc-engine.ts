// Hybrid Codex input engine.
//
// Runs one `codex app-server --listen ws://127.0.0.1:<port>` per session (the
// shared engine) and speaks JSON-RPC to it. The session's tmux pane runs the
// real `codex --remote ws://... resume <threadId>` TUI, so rendering / web
// terminal / idle detection are unchanged. User input is delivered via
// `turn/start` (an acked RPC) instead of a tmux paste — bypassing the terminal
// entirely, which is where codex drops bracketed pastes during its startup /
// settings-churn terminal re-init (see codex-0144 investigation).
//
// Coordination (verified — raw-WS repro + real `codex --remote` TUI): the
// app-server BROADCASTS a thread's turn/item events to EVERY connection that has
// the thread open (engine `thread/start`/`resume` + TUI `resume`), and the real
// TUI renders events for a turn another connection issued. So the engine owns the
// thread (`thread/start`, then the first turn — an empty thread has no rollout so
// the TUI can't resume it, hence the first turn persists the rollout BEFORE the
// TUI attaches), the TUI `resume`s it, and every engine turn thereafter renders
// live in the TUI via that broadcast. On a botmux resume (daemon restart /
// re-fork), the engine `thread/resume`s the persisted thread id AND the pane is
// respawned as a fresh `--remote resume` against the CURRENT app-server (a new
// port each incarnation) — reattaching the prior pane would leave it pointed at
// the now-dead prior app-server (that lifecycle bug, not any non-broadcast, is
// what froze the Web terminal). See codex-rpc-lifecycle + worker engageCodexRpc.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebSocket } from 'ws';

type Json = Record<string, any>;
type LogFn = (msg: string) => void;

async function findFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = addr && typeof addr === 'object' ? addr.port : 0;
      srv.close(() => (port ? resolve(port) : reject(new Error('no free port'))));
    });
  });
}

function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Kill the whole process group (node wrapper + its native app-server child).
 *  The app-server is spawned `detached`, so its pid is the group leader. */
function killGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* gone */ } }
}

export interface CodexRpcEngineOpts {
  /** Absolute path to the codex-family CLI binary (codex / traex / …). */
  cliBin: string;
  /** Working directory / agent root for the session. */
  cwd: string;
  /** Child env (must carry CODEX_HOME + proxy vars + BOTMUX_SESSION_ID). */
  env: NodeJS.ProcessEnv;
  /** botmux session id — used to name the app-server orphan-cleanup marker so a
   *  new incarnation of this session can reap a prior app-server (P0 teardown). */
  sessionId?: string;
  log?: LogFn;
  /** Optional model + reasoning effort forwarded to thread config (P1). */
  model?: string;
  reasoningEffort?: string;
  /** Override the per-request JSON-RPC timeout (default REQUEST_TIMEOUT_MS).
   *  Mainly for tests that assert the wedged-app-server recovery path. */
  requestTimeoutMs?: number;
  /** Called once if the app-server dies unexpectedly (not via stop()). The
   *  worker uses it to kill the now-orphaned `codex --remote` pane so the normal
   *  exit→daemon-refork→resume path re-engages RPC on a fresh app-server (P1). */
  onDead?: () => void;
}

/** Server→client requests are auto-answered so codex never blocks on a human;
 *  botmux already runs codex with approvals bypassed. Mirrors codex-app-runner. */
function autoApproval(method: string): unknown {
  if (method === 'item/permissions/requestApproval') return { permissions: {}, scope: 'turn' };
  if (method === 'item/tool/requestUserInput') return { answers: {} };
  if (method === 'mcpServer/elicitation/request') return { action: 'cancel', content: null, _meta: null };
  if (method === 'item/tool/call') return { contentItems: [], success: false };
  if (method === 'execCommandApproval' || method === 'applyPatchApproval') return { decision: 'approved_for_session' };
  // commandExecution / fileChange requestApproval + anything else: accept.
  return { decision: 'acceptForSession' };
}

const MARKER_DIR = join(homedir(), '.botmux', 'data', 'codex-rpc-app-servers');

/** Per JSON-RPC request timeout. Without it, a connected-but-wedged app-server
 *  (never answers turn/start / initialize / thread/*) would leave the caller
 *  awaiting forever — flushPending would stick in isFlushing and silently drop
 *  every later message (P1-5). A rejected request unblocks the caller, which
 *  fails-closed (engage) or surfaces a resync (sendTurn). Generous because the
 *  FIRST turn on a cold app-server pays MCP/model-list startup latency. */
const REQUEST_TIMEOUT_MS = 60_000;

export class CodexRpcEngine {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private port = 0;
  private threadId?: string;
  private closed = false;
  private deadNotified = false;
  private lastStderr = '';
  private readonly log: LogFn;

  constructor(private readonly opts: CodexRpcEngineOpts) {
    this.log = opts.log ?? (() => {});
  }

  get wsUrl(): string { return `ws://127.0.0.1:${this.port}`; }
  get activeThreadId(): string | undefined { return this.threadId; }
  get appServerPid(): number | undefined { return this.child?.pid; }

  /** Spawn the app-server, connect, and complete the initialize handshake. */
  async start(): Promise<void> {
    this.reapStaleAppServer();
    this.port = await findFreePort();
    this.child = spawn(this.opts.cliBin, ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Own process group so stop()/reap can kill the node wrapper AND its
      // native app-server child in one shot (killGroup → kill(-pid)).
      detached: true,
    });
    this.child.unref(); // don't let the app-server keep the worker's loop alive
    this.child.stderr?.on('data', (c: Buffer) => {
      this.lastStderr = (this.lastStderr + c.toString('utf8')).slice(-4000);
    });
    this.child.once('error', err => this.failAll(new Error(`codex app-server spawn failed: ${err.message}`)));
    this.child.once('exit', (code, signal) => {
      if (!this.closed) this.failAll(new Error(`codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
    });
    this.writeMarker();
    await this.waitReady(15_000);
    await this.connect(8_000);
    await this.request('initialize', {
      clientInfo: { name: 'botmux', version: '0.0.0', title: 'botmux' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  /** Create a fresh session thread. Its id (== codex rollout session id) is what
   *  the TUI resumes and what botmux persists for future resume. */
  async startThread(): Promise<string> {
    const r = await this.request('thread/start', this.threadParams());
    this.threadId = String(r?.thread?.id ?? '');
    if (!this.threadId) throw new Error('thread/start returned no thread id');
    return this.threadId;
  }

  /** Resume the persisted thread after a botmux reconnect (P0 resume-survival),
   *  so RPC mode stays engaged across daemon restarts instead of reverting to
   *  the paste path. */
  async resumeThread(threadId: string): Promise<string> {
    const params: Json = { ...this.threadParams(), threadId, excludeTurns: true };
    delete params.serviceName; // resume keeps the original thread's identity
    const r = await this.request('thread/resume', params);
    this.threadId = String(r?.thread?.id ?? threadId);
    return this.threadId;
  }

  private threadParams(): Json {
    const config: Json = {
      // Forward the full env (incl. BOTMUX_SESSION_ID / BOTMUX_LARK_APP_ID) to
      // shell subprocesses so `botmux send` from within codex finds its bot.
      shell_environment_policy: { inherit: 'all', ignore_default_excludes: true },
    };
    if (this.opts.model) config.model = this.opts.model;
    if (this.opts.reasoningEffort) config.model_reasoning_effort = this.opts.reasoningEffort;
    return {
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'botmux',
      ephemeral: false,
      persistExtendedHistory: true,
      config,
    };
  }

  /** Inject one user message as a turn. Resolves when the app-server acks the
   *  turn start (fast); the turn itself streams to the attached TUI. */
  async sendTurn(content: string): Promise<void> {
    if (!this.threadId) throw new Error('sendTurn before startThread/resumeThread');
    await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: content, text_elements: [] }],
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    });
  }

  stop(): void {
    this.closed = true;
    try { this.ws?.close(); } catch { /* already gone */ }
    if (this.child?.pid) { try { killGroup(this.child.pid, 'SIGTERM'); } catch { /* already gone */ } }
    this.removeMarker();
    this.failAll(new Error('engine stopped'));
  }

  // ---- app-server orphan marker (P0 teardown) ------------------------------

  private markerPath(): string | undefined {
    if (!this.opts.sessionId) return undefined;
    return join(MARKER_DIR, `${this.opts.sessionId}.pid`);
  }

  /** Kill an app-server left behind by a prior incarnation of this session
   *  (e.g. the worker was SIGKILLed so its exit hooks never ran). */
  private reapStaleAppServer(): void {
    const mp = this.markerPath();
    if (!mp || !existsSync(mp)) return;
    try {
      const pid = parseInt(readFileSync(mp, 'utf8').trim(), 10);
      if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) {
        killGroup(pid, 'SIGKILL'); // orphan from a crashed worker — no grace needed
        this.log(`[codex-rpc] reaped stale app-server pid ${pid}`);
      }
      rmSync(mp, { force: true });
    } catch { /* best effort */ }
  }

  private writeMarker(): void {
    const mp = this.markerPath();
    if (!mp || !this.child?.pid) return;
    try { mkdirSync(MARKER_DIR, { recursive: true }); writeFileSync(mp, String(this.child.pid), { mode: 0o600 }); }
    catch { /* best effort */ }
  }

  private removeMarker(): void {
    const mp = this.markerPath();
    if (mp) { try { rmSync(mp, { force: true }); } catch { /* */ } }
  }

  // ---- internals -----------------------------------------------------------

  private waitReady(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    return new Promise<void>((resolve, reject) => {
      const attempt = (): void => {
        if (this.closed) return reject(new Error('engine closed during startup'));
        const req = httpGet({ host: '127.0.0.1', port: this.port, path: '/readyz', timeout: 1500 }, res => {
          res.resume();
          if (res.statusCode && res.statusCode < 500) return resolve();
          retry();
        });
        req.once('error', retry);
        req.once('timeout', () => { req.destroy(); retry(); });
      };
      const retry = (): void => {
        if (this.closed) return reject(new Error('engine closed during startup'));
        if (Date.now() > deadline) return reject(new Error(`app-server not ready in ${timeoutMs}ms${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
        setTimeout(attempt, 250);
      };
      attempt();
    });
  }

  private connect(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(this.wsUrl);
      const timer = setTimeout(() => { try { ws.terminate(); } catch { /* */ } reject(new Error('ws connect timeout')); }, timeoutMs);
      ws.on('open', () => { clearTimeout(timer); this.ws = ws; resolve(); });
      ws.on('message', (data: Buffer) => this.onMessage(data.toString('utf8')));
      ws.on('error', (err: Error) => { clearTimeout(timer); if (!this.ws) reject(err); else this.failAll(err); });
      ws.on('close', () => { if (!this.closed) this.failAll(new Error('ws closed')); });
    });
  }

  private request(method: string, params: unknown, timeoutMs: number = this.opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        // A connected-but-wedged app-server is FATAL, not a one-off: rejecting
        // just this request would leave the engine + pane alive and every later
        // turn/start would time out again. Route through failAll so ALL inflight
        // requests reject AND onDead fires — the worker then kills the pane →
        // exit → restart → re-engage on a fresh app-server, and the inflight turn
        // enters the existing restart/re-queue path (P1-5, Codex delta point 3).
        this.failAll(new Error(`codex app-server request '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e as Error); }
    });
  }

  private notify(method: string, params?: unknown): void {
    this.send(params !== undefined ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', method });
  }

  private respond(id: number, result: unknown): void {
    try { this.send({ jsonrpc: '2.0', id, result }); } catch { /* connection gone */ }
  }

  private send(msg: Json): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new Error('app-server ws not open');
    this.ws.send(JSON.stringify(msg));
  }

  private onMessage(line: string): void {
    let msg: Json;
    try { msg = JSON.parse(line); } catch { return; }
    // Response to one of our requests.
    if (typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(typeof msg.error === 'object' ? JSON.stringify(msg.error) : String(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // Server→client request (approvals / elicitations): auto-answer.
    if (typeof msg.id === 'number' && typeof msg.method === 'string') {
      this.respond(msg.id, autoApproval(msg.method));
      return;
    }
    // Notifications (turn/item/mcp events) are ignored here — the attached TUI
    // renders them; botmux reads the pane as usual.
  }

  private failAll(err: Error): void {
    if (this.pending.size) this.log(`[codex-rpc] ${err.message}`);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
    if (!this.closed && !this.deadNotified) {
      this.deadNotified = true;
      try { this.opts.onDead?.(); } catch { /* best effort */ }
    }
  }
}
