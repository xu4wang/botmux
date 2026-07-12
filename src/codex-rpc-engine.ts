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
// Coordination (verified by spike): thread events do NOT broadcast across
// connections, so the engine must OWN the thread — `thread/start`, run the
// first turn (persists a rollout within ~0.2s), then the TUI `resume`s it.
// Subsequent turns are injected by the engine and render live in the TUI.
import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { get as httpGet } from 'node:http';
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

export interface CodexRpcEngineOpts {
  /** Absolute path to the real `codex` binary. */
  codexBin: string;
  /** Working directory / agent root for the session. */
  cwd: string;
  /** Child env (must carry CODEX_HOME + proxy vars + BOTMUX_SESSION_ID). */
  env: NodeJS.ProcessEnv;
  log?: LogFn;
  /** Optional reasoning effort override forwarded to thread/start config. */
  reasoningEffort?: string;
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

export class CodexRpcEngine {
  private child?: ChildProcess;
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private port = 0;
  private threadId?: string;
  private closed = false;
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
    this.port = await findFreePort();
    this.child = spawn(this.opts.codexBin, ['app-server', '--listen', `ws://127.0.0.1:${this.port}`], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    this.child.stderr?.on('data', (c: Buffer) => {
      this.lastStderr = (this.lastStderr + c.toString('utf8')).slice(-4000);
    });
    this.child.once('error', err => this.failAll(new Error(`codex app-server spawn failed: ${err.message}`)));
    this.child.once('exit', (code, signal) => {
      if (!this.closed) this.failAll(new Error(`codex app-server exited (code=${code}, signal=${signal})${this.lastStderr ? `\n${this.lastStderr}` : ''}`));
    });
    await this.waitReady(15_000);
    await this.connect(8_000);
    await this.request('initialize', {
      clientInfo: { name: 'botmux', version: '0.0.0', title: 'botmux' },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized');
  }

  /** Create the session thread. Its id is what the TUI resumes. */
  async startThread(): Promise<string> {
    const config: Json = {
      // Forward the full env (incl. BOTMUX_SESSION_ID / BOTMUX_LARK_APP_ID) to
      // shell subprocesses so `botmux send` from within codex finds its bot —
      // codex otherwise only forwards a curated allowlist. Mirrors the codex
      // adapter's read-isolation buildArgs.
      shell_environment_policy: { inherit: 'all', ignore_default_excludes: true },
    };
    if (this.opts.reasoningEffort) config.model_reasoning_effort = this.opts.reasoningEffort;
    const params: Json = {
      cwd: this.opts.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceName: 'botmux',
      ephemeral: false,
      persistExtendedHistory: true,
      config,
    };
    const r = await this.request('thread/start', params);
    this.threadId = String(r?.thread?.id ?? '');
    if (!this.threadId) throw new Error('thread/start returned no thread id');
    return this.threadId;
  }

  /** Inject one user message as a turn. Resolves when the app-server acks the
   *  turn start (fast); the turn itself streams to the attached TUI. */
  async sendTurn(content: string): Promise<void> {
    if (!this.threadId) throw new Error('sendTurn before startThread');
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
    try { this.child?.kill('SIGTERM'); } catch { /* already gone */ }
    this.failAll(new Error('engine stopped'));
  }

  // ---- internals ----------------------------------------------------------

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

  private request(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.pending.delete(id); reject(e as Error); }
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
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
