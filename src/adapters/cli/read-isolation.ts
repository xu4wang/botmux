/**
 * Per-bot local read isolation — the CLI-agnostic core.
 *
 * Common layer expresses the ISOLATION INTENT + CONTEXT (which paths a bot may
 * or may not read); each CLI adapter translates it into that CLI's native
 * permission mechanism. This module is pure (no fs / no spawn) so it is fully
 * unit-testable and shared across adapters. The Claude adapter consumes
 * {@link buildClaudeReadIsolationSettings}; a Codex adapter would consume the
 * same {@link ReadIsolationContext} to emit a permission profile instead.
 *
 * Threat model: a semi-trusted Feishu user driving bot A's agent must not be
 * able to read bot B's session data or credentials (bots.json is the full
 * multi-bot cred file; each bot's lark-cli config holds its app secret in
 * plaintext). See the design doc for the two-layer rationale.
 */

/** Minimum Claude Code version whose built-in sandbox supports
 *  `sandbox.filesystem.denyRead` + credential-scoped blocking. */
export const MIN_CLAUDE_SANDBOX_VERSION = '2.1.187';

export interface ReadIsolationContext {
  /** The current bot's Feishu app id (its own lark-cli config dir stays readable). */
  currentAppId: string;
  /** Every OTHER bot's app id — their lark-cli config dirs are denied. */
  otherAppIds: string[];
  /** botmux session data root (SESSION_DATA_DIR): sessions-*.json, frozen-cards, ... */
  sessionDataDir: string;
  /** The bot user's home directory. */
  homeDir: string;
  /** The CLI's transcript projects root, e.g. `<home>/.claude/projects`. */
  claudeProjectsDir: string;
  /** Per-bot extra deny paths (BotConfig.readDenyExtraPaths). */
  extraDenyPaths?: string[];
  /** Strict allowlist mode: deny the whole home, allow only {@link allowPaths}. */
  strict?: boolean;
  /** Strict-mode allow set (workspace + anything the bot legitimately needs). */
  allowPaths?: string[];
}

/** Common credential locations denied by default (opt-in feature, but once on
 *  these are covered without the user enumerating them). */
export function defaultCredentialDenyPaths(homeDir: string): string[] {
  const h = homeDir.replace(/\/+$/, '');
  return [
    `${h}/.ssh`,
    `${h}/.aws`,
    `${h}/.config/gh`,
    `${h}/.config/glab-cli`,
    `${h}/.npmrc`,
    `${h}/.docker/config.json`,
    `${h}/.kube`,
    `${h}/.git-credentials`,
  ];
}

/** The de-duplicated list of absolute paths this bot must NOT be able to read.
 *
 *  Surgical, NOT a blanket deny of SESSION_DATA_DIR: `botmux send` (run by the
 *  agent) must still read its OWN `sessions-<ownAppId>.json` to route replies.
 *  So we deny the conversation-CONTENT subdirs (transcripts, frozen cards, turn
 *  sends, crash diagnostics) + OTHER bots' session metadata files + all creds,
 *  while leaving this bot's own routing file + the daemon's own bookkeeping
 *  readable. Excludes the bot's OWN lark-cli config dir (its skills need it). */
export function buildReadDenyPaths(ctx: ReadIsolationContext): string[] {
  const h = ctx.homeDir.replace(/\/+$/, '');
  const sd = ctx.sessionDataDir.replace(/\/+$/, '');
  const ownLarkCliDir = `${h}/.lark-cli-bots/${ctx.currentAppId}`;
  const paths: string[] = [
    // Credentials
    `${h}/.botmux/bots.json`,
    `${h}/.lark-cli`,
    ...ctx.otherAppIds.map((id) => `${h}/.lark-cli-bots/${id}`),
    ...defaultCredentialDenyPaths(h),
    // Conversation content (all bots')
    ctx.claudeProjectsDir,
    `${sd}/frozen-cards`,
    `${sd}/turn-sends`,
    `${sd}/crash-diagnostics`,
    // Other bots' session metadata (own sessions-<self>.json stays readable)
    ...ctx.otherAppIds.map((id) => `${sd}/sessions-${id}.json`),
    // Per-bot extras
    ...(ctx.extraDenyPaths ?? []),
  ];
  // Never deny the bot's own lark-cli dir even if it sneaks in via extra paths.
  return dedupe(paths.filter((p) => p && p !== ownLarkCliDir));
}

/** Claude permission-rule path: absolute paths need a `//` double-slash prefix
 *  (single-slash silently fails to match — verified empirically). */
function claudePermPath(abs: string): string {
  return '//' + abs.replace(/^\/+/, '');
}

interface ClaudeSandboxFilesystem {
  denyRead: string[];
  allowRead?: string[];
}
export interface ClaudeReadIsolationSettings {
  permissions: { deny: string[] };
  sandbox: {
    enabled: true;
    failIfUnavailable: true;
    filesystem: ClaudeSandboxFilesystem;
  };
}

/**
 * Translate the intent into Claude Code `--settings`:
 *  - `sandbox.filesystem.denyRead` (kernel: Seatbelt/bwrap) covers Bash & every
 *    subprocess it spawns.
 *  - `permissions.deny` Read/Grep/Glob (CLI-enforced, survives bypassPermissions)
 *    covers the built-in file tools.
 * Both are needed — the sandbox does not govern the built-in Read tool.
 */
export function buildClaudeReadIsolationSettings(ctx: ReadIsolationContext): ClaudeReadIsolationSettings {
  const denyPaths = buildReadDenyPaths(ctx);
  const permDeny: string[] = [];
  for (const p of denyPaths) {
    const pp = claudePermPath(p);
    // Exact (for files) + subtree glob (for dirs); Grep/Glob for search tools.
    permDeny.push(`Read(${pp})`, `Read(${pp}/**)`, `Grep(${pp}/**)`, `Glob(${pp}/**)`);
  }

  if (ctx.strict) {
    const h = ctx.homeDir.replace(/\/+$/, '');
    const ownLarkCliDir = `${h}/.lark-cli-bots/${ctx.currentAppId}`;
    const allowRead = dedupe([...(ctx.allowPaths ?? []), ownLarkCliDir]);
    return {
      permissions: { deny: permDeny },
      sandbox: {
        enabled: true,
        failIfUnavailable: true,
        filesystem: { denyRead: [h], allowRead },
      },
    };
  }

  return {
    permissions: { deny: permDeny },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      filesystem: { denyRead: denyPaths },
    },
  };
}

/**
 * Decide whether read isolation should be enabled for a session, or fail-closed.
 * Pure: the caller resolves the impure inputs (adapter capability, wrapperCli,
 * whether the CLI version meets {@link MIN_CLAUDE_SANDBOX_VERSION}).
 *  - not configured → `{ enabled: false }` (no error).
 *  - configured but unenforceable → `{ enabled: false, failClosedReason }` — the
 *    caller MUST refuse to start the session rather than run unisolated.
 *  - all satisfied → `{ enabled: true }`.
 */
export function evaluateReadIsolationGate(opts: {
  configured: boolean;
  adapterSupports: boolean;
  wrapperCliSet: boolean;
  versionOk: boolean;
}): { enabled: boolean; failClosedReason?: string } {
  if (!opts.configured) return { enabled: false };
  if (!opts.adapterSupports)
    return { enabled: false, failClosedReason: 'the CLI adapter does not support read isolation' };
  if (opts.wrapperCliSet)
    return { enabled: false, failClosedReason: 'wrapperCli strips --settings, read isolation cannot be enforced' };
  if (!opts.versionOk)
    return { enabled: false, failClosedReason: `Claude Code >= ${MIN_CLAUDE_SANDBOX_VERSION} required for read isolation` };
  return { enabled: true };
}

/** Extract the semver from `claude --version` output (e.g. "2.1.197 (Claude Code)"). */
export function parseClaudeVersion(stdout: string): string | null {
  const m = stdout.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}.${m[3]}` : null;
}

/** Numeric (not lexical) semver comparison: is `v` >= `min`? */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

function dedupe(xs: string[]): string[] {
  return Array.from(new Set(xs));
}
