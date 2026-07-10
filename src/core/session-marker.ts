import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, execSync } from 'node:child_process';

export interface AncestorSessionContext {
  sessionId: string;
  turnId?: string;
}

interface IdentityBoundSessionMarker extends AncestorSessionContext {
  procStart?: string;
}

export interface AuthenticatedAncestorSessionContext extends AncestorSessionContext {
  markerPid: number;
  procStart: string;
}

export class SessionMarkerAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionMarkerAuthenticationError';
  }
}

/**
 * Stable process-birth identity used to reject stale marker files after PID
 * reuse. Linux exposes start ticks in /proc; macOS/other Unix falls back to
 * ps(1)'s process start timestamp so mutating commands remain cross-platform.
 */
export function readProcessStartIdentity(pid: number): string | undefined {
  if (!Number.isInteger(pid) || pid <= 1) return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const closeParen = raw.lastIndexOf(')');
    if (closeParen >= 0) {
      const fields = raw.slice(closeParen + 2).trim().split(/\s+/);
      if (fields[19]) return fields[19];
    }
  } catch { /* non-Linux or process disappeared */ }
  try {
    const started = execFileSync(
      'ps',
      ['-o', 'lstart=', '-p', String(pid)],
      { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return started || undefined;
  } catch {
    return undefined;
  }
}

function parseIdentityBoundSessionMarker(raw: string): IdentityBoundSessionMarker {
  const text = raw.trim();
  if (!text.startsWith('{')) return { sessionId: text };
  try {
    const parsed = JSON.parse(text) as { sessionId?: unknown; turnId?: unknown; procStart?: unknown };
    return {
      sessionId: typeof parsed.sessionId === 'string' ? parsed.sessionId : '',
      ...(typeof parsed.turnId === 'string' ? { turnId: parsed.turnId } : {}),
      ...(typeof parsed.procStart === 'string' ? { procStart: parsed.procStart } : {}),
    };
  } catch {
    return { sessionId: '' };
  }
}

export function parseSessionMarker(raw: string): AncestorSessionContext {
  const parsed = parseIdentityBoundSessionMarker(raw);
  return {
    sessionId: parsed.sessionId,
    ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
  };
}

/**
 * Strong marker lookup for authority-bearing commands. Unlike the legacy
 * read/reply resolver, this requires the worker's JSON procStart binding and
 * verifies it against the live ancestor process before returning identity.
 */
export function findAuthenticatedAncestorSessionContext(
  dataDir: string,
  startPid: number = process.ppid,
): AuthenticatedAncestorSessionContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      let marker: IdentityBoundSessionMarker;
      try {
        marker = parseIdentityBoundSessionMarker(readFileSync(markerPath, 'utf-8'));
      } catch (err) {
        throw new SessionMarkerAuthenticationError(
          `无法读取 CLI process marker ${markerPath}：${err instanceof Error ? err.message : String(err)}`,
        );
      }
      if (!marker.sessionId || !marker.turnId || !marker.procStart) {
        throw new SessionMarkerAuthenticationError(
          `CLI process marker ${markerPath} 缺少 sessionId/turnId/procStart，不能用于变更操作授权`,
        );
      }
      const liveStart = readProcessStartIdentity(pid);
      if (!liveStart || liveStart !== marker.procStart) {
        throw new SessionMarkerAuthenticationError(
          `CLI process marker ${markerPath} 已过期或 PID 被复用，拒绝授权`,
        );
      }
      return {
        sessionId: marker.sessionId,
        turnId: marker.turnId,
        markerPid: pid,
        procStart: marker.procStart,
      };
    }
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      pid = parseInt(out, 10);
      if (isNaN(pid)) break;
    } catch { break; }
  }
  return null;
}

/**
 * Walk the process tree looking for a CLI-pid marker written by the botmux
 * worker. Legacy markers contain just the session id; new markers are JSON and
 * also carry the current inbound turn id so long-lived CLI processes can route
 * `botmux send` to the correct topic alias on the 2nd/Nth turn.
 */
export function findAncestorSessionContext(dataDir: string, startPid: number = process.ppid): AncestorSessionContext | null {
  const markersDir = join(dataDir, '.botmux-cli-pids');
  if (!existsSync(markersDir)) return null;

  let pid = startPid;
  for (let depth = 0; depth < 8 && pid > 1; depth++) {
    const markerPath = join(markersDir, String(pid));
    if (existsSync(markerPath)) {
      try { return parseSessionMarker(readFileSync(markerPath, 'utf-8')); } catch { return { sessionId: '' }; }
    }
    try {
      const out = execSync(`ps -o ppid= -p ${pid}`, { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      pid = parseInt(out, 10);
      if (isNaN(pid)) break;
    } catch { break; }
  }
  return null;
}

/**
 * Resolve the owning session for an in-session subcommand (`botmux send`, etc.).
 *
 * Primary signal: the process-tree marker walk above — it carries the fresh
 * per-turn turnId, so it's preferred whenever it resolves a session id.
 *
 * Fallback: `BOTMUX_SESSION_ID` from the environment. The marker walk depends on
 * an unbroken ancestry between this process and the CLI's spawn pid. That link
 * is severed whenever the subcommand runs in a detached/backgrounded process
 * (`run_in_background`, `nohup`, `&`, `setsid` → reparented to init/pid 1),
 * nested deeper than the 8-level walk, or under a separate pid-namespace — in all
 * of which the marker walk returns null even though we ARE inside a botmux
 * session. The worker injects `BOTMUX_SESSION_ID` into the CLI's env, and every
 * descendant inherits it regardless of reparenting, so it stays correct. The
 * session id never changes after spawn, so this fallback can't route to the wrong
 * session; turnId is intentionally omitted (env can't be refreshed per-turn for a
 * long-lived CLI — callers fall back to `BOTMUX_TURN_ID` when they need it).
 */
export function resolveSessionContext(
  dataDir: string,
  envSessionId: string | undefined,
  startPid: number = process.ppid,
): AncestorSessionContext | null {
  const fromMarker = findAncestorSessionContext(dataDir, startPid);
  if (fromMarker && fromMarker.sessionId) return fromMarker;
  if (envSessionId) return { sessionId: envSessionId };
  return fromMarker;
}
