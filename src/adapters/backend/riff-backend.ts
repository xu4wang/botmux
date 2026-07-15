import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { SessionBackend, SpawnOpts } from './types.js';
import { logger } from '../../utils/logger.js';

/**
 * Fallback system prompt injected into every riff task when no explicit
 * `systemPrompt` is configured. Mirrors the `<botmux_routing>` block that
 * codex/gemini/etc. get via buildBotmuxShellHints — the riff agent must use
 * `botmux send` to reply (same as any other botmux-bridged CLI), not rely on
 * passive output capture. botmux is installed in the sandbox via setupCommands.
 */
const DEFAULT_RIFF_SYSTEM_PROMPT = [
  'You are running inside a botmux-bridged session: Feishu/Lark group ↔ riff agent sandbox.',
  'The user reads on Lark and cannot see your terminal output.',
  '',
  'STEP 0 — ensure botmux is installed (the riff API has no native setup hook, so do this FIRST, before anything else):',
  '  which botmux >/dev/null 2>&1 || npm install -g botmux',
  '',
  'IMPORTANT — identity: reply ONLY with the botmux session identity injected via the BOTMUX_* environment variables (BOTMUX_LARK_APP_ID / BOTMUX_LARK_APP_SECRET / BOTMUX_CHAT_ID / BOTMUX_SESSION_ID). NEVER reply through other Feishu apps / bots / credentials you may find on this machine (e.g. cjadk / aiden integrations) — they impersonate the wrong bot and fail in groups they are not in. `botmux send` picks up the BOTMUX_* env automatically.',
  '',
  'IMPORTANT: `botmux send` / `botmux history` / `botmux quoted` / `botmux bots` are SHELL commands (CLI programs installed in $PATH), NOT MCP tools. Run them via the Bash tool — do not look for them in the MCP tool list.',
  '',
  'To send a message to the user (the only way): run `botmux send "your message"` via Bash. Attach images with `--images /path`, files with `--files /path`.',
  'Multi-line messages MUST use a heredoc — never `botmux send "line1\\nline2"`, since `\\n` may appear literally in Lark.',
  "Correct multi-line example:\n  botmux send <<'EOF'\n  line 1\n  line 2\n  EOF",
  '',
  'Helpers: `botmux history` (read this session\'s history), `botmux quoted <message_id>` (fetch a quoted message), `botmux bots list` (list other bots in the group).',
  '',
  '@ decision (mandatory): every `botmux send` MUST explicitly pick one or it errors — `--mention <open_id>` (use the open_id from the <sender> tag of the message you are answering, or another explicit target) / `--mention-back` (@ the sender recorded in the session, may be unavailable here) / `--no-mention` (none). Prefer `--mention <sender open_id>` for substantive conclusions; `--no-mention` for low-priority notes.',
  '',
  'When to send: key conclusions, plans (wait for user approval before acting), final results, progress updates. A bare `print`/`echo` does NOT count as a reply.',
  'COMPLETION CONTRACT: a turn is complete ONLY after `botmux send` actually ran and printed ✓ success. Writing the answer solely in your final report/output does NOT reach the user — always run `botmux send` first, then summarize in the report.',
  'Keep final answers concise. For images/files: write them to disk then send via `botmux send --images/--files`.',
  '',
  'LAST-RESORT fallback (only if the npm install itself fails): call the Feishu Open API directly with the injected BOTMUX_LARK_APP_ID/SECRET — fetch a tenant_access_token, then POST im/v1/messages?receive_id_type=chat_id to BOTMUX_CHAT_ID. Still never use non-BOTMUX credentials.',
].join('\n');

/**
 * Mandatory setup commands run in the riff sandbox to ensure `botmux` is
 * available. These are ALWAYS sent to the riff API via `config.setupCommands`
 * (not via prompt injection) so the install is reliable and not dependent on
 * the agent parsing a prompt. The riff sandbox has Node.js (it runs aiden),
 * so npm install works. Any user-configured setupCommands are appended AFTER
 * these mandatory commands.
 */
const MANDATORY_SETUP_COMMANDS = [
  // Unconditional install/upgrade: a `which botmux` guard would skip the
  // install when the sandbox image preinstalls an older botmux, freezing the
  // sandbox on a version without riff-aware `botmux send`. Falls back to any
  // preinstalled botmux only when the install itself fails (e.g. npm offline).
  // Tracks the npm `latest` dist-tag — riff-aware `botmux send` ships in
  // v2.109.0+; pinning a prerelease dist-tag here would let any future
  // unrelated canary publish break riff sandboxes.
  'npm install -g botmux >/dev/null 2>&1 || which botmux >/dev/null 2>&1',
];

export interface RiffBackendConfig {
  baseUrl: string;
  templateId?: string;
  agent?: string;
  model?: string;
  /** Direct JWT token (takes precedence over jwtEnv). */
  jwt?: string;
  /** Name of env var containing the JWT token (default: RIFF_JWT). */
  jwtEnv?: string;
  sandboxCluster?: string;
  /**
   * Repos to clone into the riff sandbox, in the API's native shape
   * ({ repoName: 'group/repo', repoBranch? }). Takes precedence over
   * defaultRepo/defaultBranch. Typically derived by the worker from the
   * session's local workingDir (复用本地仓库+分支) — see
   * deriveRiffRepoFromWorkingDir.
   */
  repos?: RiffRepoRef[];
  /** Human-readable notes about the derived repo state (dirty tree, unpushed
   *  commits). Printed as status lines on task creation so the user knows the
   *  sandbox may not see their latest local changes. */
  repoWarnings?: string[];
  injectStatusLines?: boolean;
  logLevel?: string;
  /**
   * Environment variables injected into the riff sandbox execution environment.
   * Merged from: botmux session context vars (BOTMUX_SESSION_ID, …) → per-bot
   * env (bots.json `env`) → explicit config.env (which takes precedence).
   * The sandbox installs botmux via setupCommands, so BOTMUX_* vars are needed
   * for the agent to use `botmux send`. Sent as `config.env` to the riff API.
   */
  env?: Record<string, string>;
  /**
   * System prompt injected into the riff task. Prepended to the userPrompt
   * (riff API has no separate system-prompt field) so the agent knows it is
   * running inside a botmux-bridged session. When unset, the built-in
   * DEFAULT_RIFF_SYSTEM_PROMPT is used as a fallback.
   */
  systemPrompt?: string;
  /**
   * ADDITIONAL shell commands run in the riff sandbox before the agent starts
   * working. botmux is ALWAYS installed via MANDATORY_SETUP_COMMANDS (not
   * user-editable, sent to the riff API as config.setupCommands); these are
   * extra commands the user wants to run after that (e.g. installing other
   * dependencies). Sent to the riff API as `config.setupCommands` appended
   * after the mandatory botmux install commands.
   */
  setupCommands?: string[];
}

export interface RiffRepoRef {
  /** Internal repo name, e.g. 'webinfra/agent-monorepo' (code.byted.org). */
  repoName: string;
  /** Branch to pin. Omitted → the repo's default branch. (The riff API
   *  ignores unknown fields like `branch`; `repoBranch` is the real one —
   *  verified empirically: it normalizes to gitRef/gitRefType/gitCommitId.) */
  repoBranch?: string;
}

/**
 * Normalize a git origin URL / repo spec to riff's internal repoName.
 * Accepts `git@code.byted.org:group/repo.git`, `https://code.byted.org/group/repo(.git)`
 * and bare `group/repo`. Returns null for non-internal hosts (github.com etc.) —
 * the riff API validates repoName against the internal registry and cannot
 * clone external repos.
 */
export function parseRiffRepoName(spec: string): string | null {
  const s = spec.trim();
  if (!s) return null;
  let m = /^git@code\.byted\.org:([^/\s]+\/[^/\s]+?)(?:\.git)?$/.exec(s);
  if (m) return m[1]!;
  m = /^https?:\/\/code\.byted\.org\/([^/\s]+\/[^/\s]+?)(?:\.git)?(?:\/)?$/.exec(s);
  if (m) return m[1]!;
  // Bare group/repo (no scheme, no host) — pass through as-is.
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return s;
  return null;
}

/**
 * Derive the riff repo ref from a local checkout so a riff task executes
 * against the same repo + branch the botmux session works in (复用本地仓库).
 * All git calls are local (no network). Returns null when the workingDir is
 * not a git repo or its origin is not an internal repo riff can clone.
 * `warnings` surface states the sandbox cannot see (dirty tree, unpushed
 * commits, never-pushed branch) — callers inject them as status lines.
 */
export function deriveRiffRepoFromWorkingDir(
  workingDir: string,
  runGit: (args: string[]) => string | null = defaultRunGit(workingDir),
): { repo: RiffRepoRef; warnings: string[] } | null {
  const origin = runGit(['remote', 'get-url', 'origin']);
  if (!origin) return null;
  const repoName = parseRiffRepoName(origin);
  if (!repoName) return null;

  const warnings: string[] = [];
  const branch = runGit(['rev-parse', '--abbrev-ref', 'HEAD']);
  const repo: RiffRepoRef = { repoName };

  if (branch && branch !== 'HEAD') {
    const remoteRef = runGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    if (remoteRef) {
      repo.repoBranch = branch;
      const ahead = runGit(['rev-list', '--count', `refs/remotes/origin/${branch}..HEAD`]);
      if (ahead && ahead !== '0') {
        warnings.push(`本地分支 ${branch} 领先远端 ${ahead} 个未推送提交，沙箱只能看到已推送内容`);
      }
    } else {
      warnings.push(`本地分支 ${branch} 未推送到远端，沙箱将使用默认分支`);
    }
  }
  const dirty = runGit(['status', '--porcelain']);
  if (dirty) {
    warnings.push('本地工作区有未提交改动，沙箱只能看到已推送内容');
  }
  return { repo, warnings };
}

/**
 * Multi-repo aware derivation. The repo-select card's 多仓库 mode puts the
 * session in a PARENT dir containing one worktree per selected repo — the
 * parent itself is not a git repo, so probe its immediate child dirs and
 * derive each. A direct git workingDir still yields a single repo. The first
 * repo becomes riff's `primary`, the rest `workspace` (server-assigned).
 * Returns null when nothing derivable is found.
 */
export function deriveRiffReposFromWorkingDir(
  workingDir: string,
  deps: {
    deriveOne?: typeof deriveRiffRepoFromWorkingDir;
    listChildDirs?: (dir: string) => string[];
  } = {},
): { repos: RiffRepoRef[]; warnings: string[] } | null {
  const deriveOne = deps.deriveOne ?? deriveRiffRepoFromWorkingDir;
  const direct = deriveOne(workingDir);
  if (direct) return { repos: [direct.repo], warnings: direct.warnings };

  const listChildDirs = deps.listChildDirs ?? defaultListChildDirs;
  const repos: RiffRepoRef[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const child of listChildDirs(workingDir)) {
    const derived = deriveOne(child);
    if (!derived || seen.has(derived.repo.repoName)) continue;
    seen.add(derived.repo.repoName);
    repos.push(derived.repo);
    const label = derived.repo.repoName;
    warnings.push(...derived.warnings.map(w => `[${label}] ${w}`));
  }
  return repos.length > 0 ? { repos, warnings } : null;
}

/** Immediate child directories (skip hidden), capped to keep the scan cheap. */
function defaultListChildDirs(dir: string, cap = 16): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.'))
      .slice(0, cap)
      .map(e => join(dir, e.name));
  } catch {
    return [];
  }
}

function defaultRunGit(cwd: string): (args: string[]) => string | null {
  return (args: string[]) => {
    try {
      const out = execFileSync('git', ['-C', cwd, ...args], {
        encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      const trimmed = out.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  };
}

interface RiffAttachment {
  path: string;
  name: string;
  type: 'image' | 'file';
}

interface RiffTaskResponse {
  success: boolean;
  data: {
    id: string;
    status: string;
    accessUrl?: string;
    directAccessUrl?: string;
    queuePosition?: number | null;
  };
}

/**
 * RiffBackend — bridges botmux's SessionBackend interface to riff's HTTP API.
 *
 * Lifecycle:
 *   spawn()       → initializes riff client (no actual task created yet)
 *   write(text)   → creates a task (first write) or follow-up (subsequent writes)
 *                   SSE output events flow through onData callback
 *   kill()        → cancels current task via task-cancel
 *   onExit        → fires on /close (kill) or unrecoverable error, NOT on task done
 *
 * SSE events use standard SSE format: event type in `event:` line, JSON in `data:` lines.
 * Events: output (text chunks), status (state changes), init (full state + accessUrl),
 * session_info (sandbox access info), done (task completion), log (verbose logs).
 */
export class RiffBackend implements SessionBackend {
  private config: RiffBackendConfig;
  private sessionId: string;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((code: number | null, signal: string | null) => void) | null = null;
  private accessUrlCb: ((url: string) => void) | null = null;
  private taskDoneCb: (() => void) | null = null;
  private outputBuffer = '';
  private currentTaskId: string | null = null;
  private currentAccessUrl: string | null = null;
  /** True when currentAccessUrl is the sandbox directAccessUrl (never downgrade it). */
  private accessUrlIsDirect = false;
  private abortController: AbortController | null = null;
  private killed = false;
  private taskDone = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 3;
  /** Serializes write() → createTask/followUp. Without this, a second message
   *  arriving before the first task-execute HTTP returns would see
   *  currentTaskId === null and create a duplicate task. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(config: RiffBackendConfig, sessionId: string) {
    this.config = config;
    this.sessionId = sessionId;
  }

  /** Called when the riff sandbox accessUrl becomes available or changes. */
  onAccessUrl(cb: (url: string) => void): void {
    this.accessUrlCb = cb;
    if (this.currentAccessUrl) cb(this.currentAccessUrl);
  }

  /** Called when the current riff task completes or fails (turn boundary). */
  onTaskDone(cb: () => void): void {
    this.taskDoneCb = cb;
  }

  /** Resolve JWT dynamically — re-reads env/keychain each call so auto-refresh works. */
  private getJwt(): string | null {
    return this.resolveJwt();
  }

  private resolveJwt(): string | null {
    if (this.config.jwt) return this.config.jwt;
    const envKey = this.config.jwtEnv ?? 'RIFF_JWT';
    const fromEnv = process.env[envKey];
    if (fromEnv) return fromEnv;

    // Fallback: try ByteCloud Auth SDK keychain (kaboo-cli / aiden-cli / cjadk)
    const fromKeychain = this.readJwtFromBytecloudKeychain();
    if (fromKeychain) {
      logger.info(`[riff] JWT loaded from ByteCloud keychain`);
      return fromKeychain;
    }

    logger.warn(`[riff] JWT not found in config, env ${envKey}, or ByteCloud keychain; API calls will fail`);
    return null;
  }

  private readJwtFromBytecloudKeychain(): string | null {
    const home = process.env.HOME ?? '~';
    const candidates = [
      `${home}/.config/kaboo-cli/bytecloud-auth/keychain/auth/cn/default`,
      `${home}/.config/aiden-cli/bytecloud-auth/keychain/auth/cn/default`,
      `${home}/.cjadk/bytecloud-auth/keychain/auth/cn/default`,
    ];
    for (const path of candidates) {
      try {
        const raw = readFileSync(path, 'utf-8');
        const data = JSON.parse(raw) as Record<string, unknown>;
        const jwt = data['bytecloud_jwt'] as string | undefined;
        if (jwt) return jwt;
      } catch { /* try next */ }
    }
    return null;
  }

  spawn(_bin: string, _args: string[], _opts: SpawnOpts): void {
    logger.info(`[riff] spawn (ignoring bin/args, using config: ${this.config.baseUrl})`);
    // No actual process to spawn. Task creation happens on first write().
  }

  write(data: string): void {
    if (this.killed) return;

    const { text, attachments } = this.extractAttachments(data);

    this.writeChain = this.writeChain
      .then(async () => {
        if (this.killed) return;
        // Route by task lineage only: task-follow-up is exactly the "continue
        // the conversation after the parent finished" API, so a completed task
        // (taskDone) must still route to followUp — spinning up a fresh task
        // per turn would cold-boot a new sandbox (minutes) and drop context.
        this.taskDone = false;
        if (!this.currentTaskId) {
          await this.createTask(text, attachments);
        } else {
          await this.followUp(text, attachments);
        }
      })
      .catch((err) => {
        logger.warn(`[riff] queued write failed: ${err}`);
      });
  }

  resize(_cols: number, _rows: number): void {
    // No terminal screen to resize.
  }

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }

  onExit(cb: (code: number | null, signal: string | null) => void): void {
    this.exitCb = cb;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    logger.info('[riff] kill requested');

    if (this.currentTaskId && !this.taskDone) {
      this.cancelTask(this.currentTaskId).catch((err) => {
        logger.warn(`[riff] task-cancel failed: ${err}`);
      });
    }

    this.abortController?.abort();
    this.exitCb?.(0, null);
  }

  destroySession(): void {
    this.kill();
  }

  getChildPid(): number | null {
    return null;
  }

  captureCurrentScreen(): string {
    return this.outputBuffer;
  }

  captureViewport(): string {
    return this.outputBuffer;
  }

  getPaneSize(): { cols: number; rows: number } | null {
    return null;
  }

  // ── Private helpers ──────────────────────────────────────────────

  /**
   * Emit a styled status line into the terminal stream. The worker renders
   * this through a headless xterm — bare `\n` (no carriage return) makes
   * lines stair-step to the right, which is the main reason the raw log view
   * was hard to read. Always emit `\r\n` and reset ANSI styling per line.
   */
  private emitLine(text: string, style: 'info' | 'warn' | 'ok' | 'err' | 'title' | 'plain' = 'info'): void {
    const codes: Record<string, string> = {
      info: '\x1b[36m',   // cyan — routine status
      warn: '\x1b[33m',   // yellow — degraded/attention
      ok: '\x1b[32m',     // green — completion
      err: '\x1b[31m',    // red — failure
      title: '\x1b[1m',   // bold — section separators
      plain: '',
    };
    const open = codes[style] ?? '';
    const close = open ? '\x1b[0m' : '';
    const line = `\r\n${open}${text}${close}\r\n`;
    this.outputBuffer += line;
    this.dataCb?.(line);
  }

  /** Normalize newlines for xterm rendering (bare \n → \r\n, keep existing \r\n). */
  private emitText(text: string): void {
    const normalized = text.replace(/\r?\n/g, '\r\n');
    this.outputBuffer += normalized;
    this.dataCb?.(normalized);
  }

  private extractAttachments(content: string): { text: string; attachments: RiffAttachment[] } {
    const attachments: RiffAttachment[] = [];
    const attachRegex = /<attachments[^>]*>([\s\S]*?)<\/attachments>/g;
    let match: RegExpExecArray | null;
    let text = content;

    while ((match = attachRegex.exec(content)) !== null) {
      const block = match[1]!;
      const imgRegex = /<image\s+[^>]*path="([^"]+)"[^>]*\/>/g;
      const fileRegex = /<file\s+[^>]*path="([^"]+)"(?:\s+name="([^"]*)")?[^>]*\/>/g;
      let m: RegExpExecArray | null;
      while ((m = imgRegex.exec(block)) !== null) {
        attachments.push({ path: m[1]!, name: this.basename(m[1]!), type: 'image' });
      }
      while ((m = fileRegex.exec(block)) !== null) {
        attachments.push({ path: m[1]!, name: m[2] ?? this.basename(m[1]!), type: 'file' });
      }
      text = text.replace(match[0]!, '').trim();
    }

    return { text, attachments };
  }

  private basename(p: string): string {
    const parts = p.split(/[/\\]/);
    return parts[parts.length - 1] ?? p;
  }

  private async createTask(prompt: string, attachments: RiffAttachment[]): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-execute`;

    // riff task-execute body: origin at top level, prompt inside config.userPrompt
    // agent 可选值: aiden (默认), aiden-claude, codex, opencode
    const config: Record<string, unknown> = {
      userPrompt: this.injectSystemPrompt(prompt),
      agent: this.config.agent ?? 'aiden',
    };
    if (this.config.model) config.model = this.config.model;
    if (this.config.sandboxCluster) config.sandboxCluster = this.config.sandboxCluster;
    // Repos: explicit config.repos (e.g. derived from the session's local
    // workingDir by the worker) wins over defaultRepo/defaultBranch. The API's
    // native shape is { repoName, repoBranch } — it silently ignores unknown
    // fields, so anything else never pins the branch.
    const repos = this.buildRepos();
    if (repos.length > 0) {
      config.repos = repos;
      if (this.config.injectStatusLines !== false) {
        const desc = repos.map(r => r.repoBranch ? `${r.repoName}@${r.repoBranch}` : `${r.repoName}(默认分支)`).join(', ');
        this.emitLine(`[riff] 仓库: ${desc}`);
        for (const w of this.config.repoWarnings ?? []) this.emitLine(`[riff] ⚠️ ${w}`, 'warn');
      }
    }
    // Inject env into the riff sandbox so the agent can use `botmux send` etc.
    // Merged from: per-bot env (bots.json `env`) + botmux session context vars +
    // any explicit config.env (which takes precedence).
    const env = this.buildEnv();
    if (Object.keys(env).length > 0) config.env = env;
    // Always send setupCommands to the riff API: mandatory botmux install first
    // (MANDATORY_SETUP_COMMANDS, not user-editable), then any user-configured
    // additional commands. botmux is installed via the API's native
    // setupCommands support — NOT via prompt injection — so it is reliable.
    const setup = [...MANDATORY_SETUP_COMMANDS, ...(this.config.setupCommands ?? [])];
    config.setupCommands = setup;

    const payload: Record<string, unknown> = {
      origin: 'botmux',
      threadId: this.sessionId,
      config,
      useRunner: true,
    };
    if (this.config.templateId) payload.templateId = this.config.templateId;

    try {
      const taskId = await this.uploadAndCreate(url, payload, attachments);
      this.currentTaskId = taskId;
      this.streamTask(taskId);
    } catch (err) {
      this.emitError(`创建 riff 任务失败: ${err}`);
    }
  }

  private async followUp(prompt: string, attachments: RiffAttachment[]): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-follow-up`;

    // riff task-follow-up body: parentTaskId + origin + prompt at top level
    const payload: Record<string, unknown> = {
      origin: 'botmux',
      parentTaskId: this.currentTaskId,
      prompt: this.injectSystemPrompt(prompt),
    };

    try {
      const taskId = await this.uploadAndCreate(url, payload, attachments);
      this.currentTaskId = taskId;
      this.streamTask(taskId);
    } catch (err) {
      // Broken lineage (parent expired/GC'd etc.) — fall back to a fresh task
      // on the next message instead of failing every follow-up forever.
      this.currentTaskId = null;
      this.emitError(`riff follow-up 失败: ${err}（下一条消息将新建任务）`);
    }
  }

  /**
   * Prepend the configured system prompt to the user prompt.
   * The riff API has no separate system-prompt field (only userPrompt), so we
   * fold the system prompt into the prompt text. config.systemPrompt takes
   * precedence over the built-in DEFAULT_RIFF_SYSTEM_PROMPT. The result is
   * wrapped in a <system> block so the agent can distinguish it from the user
   * message. NOTE: setup commands (botmux install) are NOT injected here —
   * they are sent to the riff API via config.setupCommands for reliability.
   */
  private injectSystemPrompt(prompt: string): string {
    const sys = this.config.systemPrompt?.trim() ?? DEFAULT_RIFF_SYSTEM_PROMPT;
    if (!sys) return prompt;
    return `<system>\n${sys}\n</system>\n\n${prompt}`;
  }

  /**
   * Build the env object for the riff sandbox. Precedence (highest wins):
   *   1. config.env (explicit per-bot riff config)
   *   2. per-bot env from bots.json `env` (merged by the worker into config.env)
   * Returns a clean Record with empty values dropped.
   */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    if (this.config.env) {
      for (const [k, v] of Object.entries(this.config.env)) {
        if (v != null && v !== '') env[k] = String(v);
      }
    }
    return env;
  }

  private async uploadAndCreate(
    url: string,
    payload: Record<string, unknown>,
    attachments: RiffAttachment[],
  ): Promise<string> {
    const headers: Record<string, string> = {};
    const jwt = this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;

    let resp: Response;
    if (attachments.length > 0) {
      const form = new FormData();
      form.append('payload', JSON.stringify(payload));
      for (const att of attachments) {
        try {
          const fileData = await this.readFileAsBlob(att.path);
          form.append('attachments', fileData, att.name);
        } catch (err) {
          logger.warn(`[riff] failed to read attachment ${att.path}: ${err}`);
        }
      }
      resp = await fetch(url, { method: 'POST', headers, body: form });
    } else {
      headers['Content-Type'] = 'application/json';
      resp = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload) });
    }

    if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
    const result = (await resp.json()) as RiffTaskResponse;
    if (!result.success || !result.data?.id) {
      throw new Error(`riff API returned error: ${JSON.stringify(result)}`);
    }

    // New task → new sandbox URLs may flow in; allow them to replace the old ones.
    this.accessUrlIsDirect = false;
    this.updateAccessUrl(result.data);

    // If queued, inject a status line
    if (result.data.status === 'queued' && result.data.queuePosition != null) {
      this.emitLine(`[riff] 任务排队中，位置: ${result.data.queuePosition}`, 'warn');
    }

    return result.data.id;
  }

  private async readFileAsBlob(path: string): Promise<Blob> {
    const { readFile } = await import('node:fs/promises');
    const buf = await readFile(path);
    return new Blob([buf]);
  }

  /** Repos come exclusively from config.repos (worker-derived from the session
   *  workingDir). The old defaultRepo/defaultBranch bot config was removed —
   *  a stale bots.json value would silently shadow the workingDir derivation
   *  with no UI left to clear it. */
  private buildRepos(): RiffRepoRef[] {
    return this.config.repos && this.config.repos.length > 0 ? this.config.repos : [];
  }

  private async cancelTask(taskId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api/task-cancel`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const jwt = this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;
    await fetch(url, {
      method: 'POST',
      headers,
      // The API expects { id } — { taskId } is silently rejected ("id Required").
      body: JSON.stringify({ id: taskId }),
    }).catch(() => { /* best effort */ });
  }

  private async streamTask(taskId: string): Promise<void> {
    const url = `${this.config.baseUrl}/api2/task-stream?id=${encodeURIComponent(taskId)}`;
    const headers: Record<string, string> = {};
    const jwt = this.getJwt();
    if (jwt) headers['x-jwt-token'] = jwt;

    this.abortController = new AbortController();

    try {
      const resp = await fetch(url, { headers, signal: this.abortController.signal });
      if (!resp.ok || !resp.body) {
        throw new Error(`SSE HTTP ${resp.status}`);
      }

      this.reconnectAttempts = 0;
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Standard SSE: events separated by blank line (\n\n)
        const events = buffer.split('\n\n');
        buffer = events.pop() ?? '';

        for (const eventBlock of events) {
          this.handleSseEvent(eventBlock, taskId);
        }
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      logger.warn(`[riff] SSE stream error: ${err}`);

      // Attempt reconnect if task is still running
      if (!this.killed && !this.taskDone && this.reconnectAttempts < this.maxReconnectAttempts) {
        this.reconnectAttempts++;
        const delay = 1000 * this.reconnectAttempts;
        logger.info(`[riff] SSE reconnect attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts} in ${delay}ms`);
        this.emitLine(`[riff] 连接中断，正在重连 (${this.reconnectAttempts}/${this.maxReconnectAttempts})`, 'warn');
        await new Promise((r) => setTimeout(r, delay));
        this.streamTask(taskId);
      } else if (!this.killed && !this.taskDone) {
        this.emitError(`SSE 连接中断，重连失败`);
      }
    }
  }

  private handleSseEvent(block: string, taskId: string): void {
    // Standard SSE parsing: event type from `event:` line, data from `data:` lines
    // Also handle SSE comments (lines starting with `:`) — ignore them (heartbeats)
    let eventType = 'message';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith(':')) continue; // SSE comment / heartbeat
      if (line.startsWith('event:')) {
        eventType = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (dataLines.length === 0) return;

    try {
      const data = JSON.parse(dataLines.join('\n')) as Record<string, unknown>;

      switch (eventType) {
        case 'output': {
          const chunk = data['chunk'] as string | undefined;
          if (chunk) this.emitText(chunk);
          break;
        }
        case 'status': {
          if (this.config.injectStatusLines !== false) {
            const status = data['status'] as string | undefined;
            if (status) this.emitLine(`[riff] 状态: ${status}`);
          }
          break;
        }
        case 'init':
        case 'session_info': {
          // accessUrl lives in init / session_info events, not in done
          const changed = this.updateAccessUrl({
            accessUrl: data['accessUrl'] as string | undefined,
            directAccessUrl: data['directAccessUrl'] as string | undefined,
          });
          if (changed && this.currentAccessUrl && this.config.injectStatusLines !== false) {
            this.emitLine(`[riff] Sandbox: ${this.currentAccessUrl}`);
          }
          // SSE events usually carry only accessUrl (riff frontend page — its
          // domain may not match the configured baseUrl environment). The
          // directly-openable AIO sandbox terminal lives in task-detail's
          // directAccessUrl — try to upgrade once the first URL arrives.
          if (changed && !this.accessUrlIsDirect) {
            void this.fetchDirectAccessUrl(taskId);
          }
          break;
        }
        case 'done': {
          // Idempotency: streams can deliver done more than once (observed
          // ~500ms apart live). A duplicate must not re-fire the turn-boundary
          // callback — it would mark the session ready mid-way through the
          // NEXT task's execution.
          if (this.taskDone) break;
          this.taskDone = true;
          const status = data['status'] as string | undefined;
          const exitCode = data['exitCode'] as number | undefined;
          if (this.config.injectStatusLines !== false) {
            this.emitLine(`[riff] 任务完成${status ? ` (${status}${exitCode != null ? `, exit=${exitCode}` : ''})` : ''}`, status === 'failed' ? 'warn' : 'ok');
          }
          // Fetch final output from task-detail API (SSE has no output events for runner tasks)
          if (status === 'completed' || status === 'failed') {
            this.fetchAndEmitOutput(taskId);
          }
          // Turn boundary: let the worker re-arm prompt-ready and flush queued
          // follow-ups — riff has no PTY/idle detector to do it otherwise.
          this.taskDoneCb?.();
          // NOTE: task done does NOT trigger onExit — session stays alive
          // for follow-up messages. Only /close or unrecoverable errors exit.
          break;
        }
        case 'log': {
          const text = data['text'] as string | undefined;
          const kind = data['kind'] as string | undefined;
          const group = (data['group'] as string | undefined)
            ?? (data['payload'] as Record<string, unknown> | undefined)?.['group'] as string | undefined;
          // stdout logs are the real output stream — emit as data regardless of logLevel
          if (group === 'stdout' && text) {
            this.emitText(text);
          } else if (this.config.logLevel === 'verbose' && text) {
            this.emitLine(`[riff:${kind ?? 'log'}] ${text}`);
          }
          break;
        }
      }
    } catch (err) {
      logger.warn(`[riff] failed to parse SSE event: ${err}`);
    }
  }

  /**
   * Track the best sandbox URL for the "Web 终端" button.
   * Preference: directAccessUrl (the AIO sandbox terminal, directly openable)
   * over accessUrl (riff frontend page — hardcoded to the production domain
   * even on BOE deployments, so its origin is rewritten to the configured
   * baseUrl). A direct URL is never downgraded back to a frontend URL within
   * the same task. Returns true when the current URL changed.
   */
  private updateAccessUrl(src: { accessUrl?: string; directAccessUrl?: string }): boolean {
    let next: string | null = null;
    let isDirect = false;
    if (src.directAccessUrl) {
      next = src.directAccessUrl;
      isDirect = true;
    } else if (src.accessUrl && !this.accessUrlIsDirect) {
      next = this.rewriteToBaseOrigin(src.accessUrl);
    }
    if (!next || next === this.currentAccessUrl) return false;
    this.currentAccessUrl = next;
    this.accessUrlIsDirect = isDirect;
    this.accessUrlCb?.(next);
    return true;
  }

  /** Rewrite a riff frontend URL onto the configured baseUrl origin (BOE vs prod). */
  private rewriteToBaseOrigin(url: string): string {
    try {
      const u = new URL(url);
      const base = new URL(this.config.baseUrl);
      if (u.origin === base.origin) return url;
      return `${base.origin}${u.pathname}${u.search}${u.hash}`;
    } catch {
      return url;
    }
  }

  /** One-shot task-detail fetch to pick up directAccessUrl (not present in SSE events). */
  private async fetchDirectAccessUrl(taskId: string): Promise<void> {
    try {
      const url = `${this.config.baseUrl}/api/task-detail?id=${encodeURIComponent(taskId)}`;
      const headers: Record<string, string> = {};
      const jwt = this.getJwt();
      if (jwt) headers['x-jwt-token'] = jwt;
      const resp = await fetch(url, { headers });
      if (!resp.ok) return;
      const result = (await resp.json()) as {
        success: boolean;
        data?: { task?: { accessUrl?: string; directAccessUrl?: string } };
      };
      const task = result.data?.task;
      if (task) this.updateAccessUrl(task);
    } catch (err) {
      logger.warn(`[riff] fetchDirectAccessUrl failed: ${err}`);
    }
  }

  private emitError(message: string): void {
    this.emitLine(`[riff] 错误: ${message}`, 'err');
    logger.error(`[riff] ${message}`);
    // A failed task is also a turn boundary — without this, a task-execute /
    // follow-up / SSE failure would leave the worker "busy" forever and queued
    // messages would never flush.
    this.taskDone = true;
    this.taskDoneCb?.();
  }

  private async fetchAndEmitOutput(taskId: string): Promise<void> {
    try {
      const url = `${this.config.baseUrl}/api/task-detail?id=${encodeURIComponent(taskId)}`;
      const headers: Record<string, string> = {};
      const jwt = this.getJwt();
      if (jwt) headers['x-jwt-token'] = jwt;

      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        logger.warn(`[riff] task-detail fetch failed: HTTP ${resp.status}`);
        return;
      }
      const result = (await resp.json()) as {
        success: boolean;
        data?: {
          task?: {
            output?: string;
            accessUrl?: string;
            directAccessUrl?: string;
            resultOutput?: {
              displayReport?: {
                content?: string;
                kind?: string;
              };
            };
          };
        };
      };

      if (result.data?.task) this.updateAccessUrl(result.data.task);

      // Prefer displayReport content (cleaner), fall back to raw output
      const displayContent = result.data?.task?.resultOutput?.displayReport?.content;
      const rawOutput = result.data?.task?.output ?? '';
      const output = displayContent && displayContent.length > 0
        ? displayContent
        : rawOutput;

      if (output && output.length > 0) {
        // Clean up: strip leading "startedcompleted" noise from aiden runner
        const cleaned = output.replace(/^(started|completed)+/, '').trim();
        if (cleaned.length > 0) {
          this.emitLine('────────── 任务报告 ──────────', 'title');
          this.emitText(cleaned + '\n');
        }
      }
    } catch (err) {
      logger.warn(`[riff] fetchAndEmitOutput failed: ${err}`);
    }
  }
}
