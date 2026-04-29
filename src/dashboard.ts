// src/dashboard.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
  readFileSync, writeFileSync, existsSync, chmodSync, mkdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { logger } from './utils/logger.js';
import { config } from './config.js';
import {
  generateToken, parseCookie, buildSetCookie, verifyHmac,
} from './dashboard/auth.js';
import { DaemonRegistry } from './dashboard/registry.js';
import { Aggregator, subscribeDaemon } from './dashboard/aggregator.js';

const SECRET_PATH = join(homedir(), '.botmux', '.dashboard-secret');
const REGISTRY_DIR = join(homedir(), '.botmux', 'data', 'dashboard-daemons');

let activeToken: string | null = null;

function loadOrCreateSecret(): string {
  if (existsSync(SECRET_PATH)) return readFileSync(SECRET_PATH, 'utf8').trim();
  const s = randomBytes(32).toString('base64url');
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, s, { mode: 0o600 });
  chmodSync(SECRET_PATH, 0o600);
  logger.info(`[dashboard] Generated dashboard secret at ${SECRET_PATH}`);
  return s;
}

const SECRET = loadOrCreateSecret();
mkdirSync(REGISTRY_DIR, { recursive: true });
const registry = new DaemonRegistry(REGISTRY_DIR);
const aggregator = new Aggregator();
const subs = new Map<string, () => void>();

function syncSubscriptions(): void {
  const online = new Set(registry.list().map(d => d.larkAppId));
  // Open new subscriptions
  for (const d of registry.list()) {
    if (!subs.has(d.larkAppId)) {
      subs.set(
        d.larkAppId,
        subscribeDaemon(d, aggregator, e =>
          logger.warn(`[aggregator] ${d.larkAppId}: ${e.message}`),
        ),
      );
    }
  }
  // Close subscriptions for offline daemons
  for (const [id, off] of subs) {
    if (!online.has(id)) { off(); subs.delete(id); }
  }
}

await registry.start();
registry.on(syncSubscriptions);
syncSubscriptions();

// Initial hydrate from each online daemon
async function hydrate(): Promise<void> {
  for (const d of registry.list()) {
    try {
      const [sRes, schRes] = await Promise.all([
        fetch(`http://127.0.0.1:${d.ipcPort}/api/sessions`),
        fetch(`http://127.0.0.1:${d.ipcPort}/api/schedules`),
      ]);
      const s = await sRes.json() as { sessions: any[] };
      const sch = await schRes.json() as { schedules: any[] };
      aggregator.hydrateSessions(d.larkAppId, s.sessions ?? []);
      aggregator.hydrateSchedules(sch.schedules ?? []);
    } catch (e: any) {
      logger.warn(`[dashboard] hydrate ${d.larkAppId}: ${e.message ?? e}`);
    }
  }
}
await hydrate();

// ─── HTTP routing ────────────────────────────────────────────────────────────

function authedToken(req: IncomingMessage, url: URL): string | undefined {
  const q = url.searchParams.get('t');
  if (q && q === activeToken) return q;
  return parseCookie(req.headers.cookie);
}

function jsonRes(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    // Health probe (no auth) — for pm2
    if (url.pathname === '/__health') {
      return jsonRes(res, 200, { ok: true });
    }

    // CLI rotate (HMAC + loopback only) — for `botmux dashboard`
    if (req.method === 'POST' && url.pathname === '/__cli/rotate') {
      const ts = req.headers['x-botmux-cli-ts'];
      const nonce = req.headers['x-botmux-cli-nonce'];
      const sig = req.headers['x-botmux-cli-auth'];
      if (typeof ts !== 'string' || typeof nonce !== 'string' || typeof sig !== 'string') {
        return jsonRes(res, 400, { error: 'missing_headers' });
      }
      const remote = (req.socket.remoteAddress ?? '').replace(/^::ffff:/, '');
      const r = verifyHmac(SECRET, { ts, nonce, sig }, remote);
      if (!r.ok) return jsonRes(res, 401, { error: 'unauthorized', reason: r.reason });
      activeToken = generateToken();
      const fullUrl = `http://${config.dashboard.externalHost}:${config.dashboard.port}/?t=${activeToken}`;
      return jsonRes(res, 200, { url: fullUrl });
    }

    // All other paths require an authenticated session.
    const tok = authedToken(req, url);
    if (!tok || tok !== activeToken) {
      res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Token expired</h1><p>Run <code>botmux dashboard</code> to get a fresh URL.</p>');
      return;
    }

    // First hit with `?t=<token>` sets the cookie + redirects to clean URL.
    if (url.searchParams.has('t')) {
      res.writeHead(302, {
        'set-cookie': buildSetCookie(tok),
        'location': url.pathname || '/',
      });
      res.end();
      return;
    }

    // Public API + static frontend land in Task 17 / 18. For now: 404.
    jsonRes(res, 404, { error: 'not_found_yet', path: url.pathname });
  } catch (err) {
    logger.error('[dashboard] handler error', err);
    if (!res.headersSent) jsonRes(res, 500, { error: String(err) });
  }
});

server.listen(config.dashboard.port, config.dashboard.host, () => {
  logger.info(`[dashboard] listening on ${config.dashboard.host}:${config.dashboard.port}`);
});

// Graceful shutdown
function shutdown(): void {
  for (const off of subs.values()) off();
  subs.clear();
  registry.stop();
  server.close(() => process.exit(0));
  // Hard-exit fallback after 5s
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
