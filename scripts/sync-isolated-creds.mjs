#!/usr/bin/env node
// 把「当前有效的登录凭证」同步进所有【读隔离】bot 的 per-bot 凭证文件，并冷重启其活跃 pane。
//
// 背景：读隔离下每个 bot 的 CLI 数据被重定向进 ~/.botmux/bots/<appId>/{claude,codex}/，
// 且 Seatbelt deny 了 ~/Library/Keychains——所以隔离 bot 只能走【文件】凭证，读不到系统
// keychain。这份文件由 daemon 在 bot 首次 provision 时写一次，之后【永不刷新】(worker.ts
// 里 `if (!existsSync(credPath))`)。于是 access token 过期 / 账号在别处重新 /login 轮换
// refresh token 后，隔离 bot 那份就作废 → 401 "run /login"。
//
// 用法（一般在 SSH 上 `claude /login` 成功后跑一次）：
//   node scripts/sync-isolated-creds.mjs            # 同步 + 冷重启活跃 pane
//   node scripts/sync-isolated-creds.mjs --no-restart   # 只更新文件，不动 pane
//   node scripts/sync-isolated-creds.mjs --dry-run      # 只看会做什么
//
// 纯操作 ~/.botmux 与 tmux，不依赖任何 checkout 的 dist——从哪跑都行。跨平台：mac 优先
// 从 keychain 取 claude token，linux 无 keychain 时退回 ~/.claude/.credentials.json。
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const HOME = homedir();
const BOTMUX_HOME = process.env.BOTMUX_HOME || join(HOME, '.botmux');
const SESSION_DATA_DIR = process.env.BOTMUX_SESSION_DATA_DIR || join(BOTMUX_HOME, 'data');
const NOW = Date.now();
const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const NO_RESTART = args.has('--no-restart');

function log(m) { process.stdout.write(m + '\n'); }
function readJson(p) { try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; } }

// ── 选出「最新有效」的 claude OAuth 凭证（原样 JSON 字符串）。候选：macOS keychain +
//    ~/.claude/.credentials.json，取 expiresAt 最大的那份（跑道最长）。──────────────
function freshClaudeCred() {
  const cands = [];
  const filePath = join(HOME, '.claude', '.credentials.json');
  if (existsSync(filePath)) {
    const raw = readFileSync(filePath, 'utf-8').trim();
    const exp = readJson(filePath)?.claudeAiOauth?.expiresAt ?? 0;
    cands.push({ src: '~/.claude/.credentials.json', raw, exp });
  }
  // keychain（仅 macOS 有 `security`）
  const r = spawnSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { encoding: 'utf-8' });
  const kc = (r.stdout ?? '').trim();
  if (kc) {
    let exp = 0; try { exp = JSON.parse(kc)?.claudeAiOauth?.expiresAt ?? 0; } catch { /* ignore */ }
    cands.push({ src: 'keychain', raw: kc, exp });
  }
  if (!cands.length) return null;
  cands.sort((a, b) => b.exp - a.exp);
  const best = cands[0];
  best.valid = best.exp > NOW;
  return best;
}

// ── codex：auth.json 就是文件，取 ~/.codex/auth.json 原样。──────────────────────────
function freshCodexAuth() {
  const p = join(HOME, '.codex', 'auth.json');
  if (!existsSync(p)) return null;
  return { src: '~/.codex/auth.json', raw: readFileSync(p, 'utf-8') };
}

function isolatedBots() {
  const bots = readJson(join(BOTMUX_HOME, 'bots.json'));
  if (!bots) { log('✗ 读不到 bots.json'); return []; }
  const list = Array.isArray(bots) ? bots : Object.values(bots);
  return list
    .filter((b) => b && b.readIsolation === true)
    .map((b) => ({ appId: b.larkAppId, cliId: b.cliId }));
}

// per-bot 凭证目标路径（与 worker.ts provisionIsolatedBotHome 一致）
function claudeCredPath(appId) { return join(BOTMUX_HOME, 'bots', appId, 'claude', '.credentials.json'); }
function codexAuthPath(appId) { return join(BOTMUX_HOME, 'bots', appId, 'codex', 'auth.json'); }

function writeCred(dst, raw) {
  const data = raw.endsWith('\n') ? raw : raw + '\n';
  // 只比 token 本体（忽略末尾换行差异），避免每次都误判「已变」而白杀 pane
  if (existsSync(dst) && readFileSync(dst, 'utf-8').trim() === raw.trim()) return false;
  if (DRY) return true;
  mkdirSync(join(dst, '..'), { recursive: true });
  writeFileSync(dst, data, { mode: 0o600 });
  chmodSync(dst, 0o600);
  return true;
}

// 该 bot 当前活跃的 tmux pane（bmx-<sid 前 8 位>）
function livePanesFor(appId) {
  const sf = join(SESSION_DATA_DIR, `sessions-${appId}.json`);
  const d = readJson(sf);
  if (!d) return [];
  const sessions = Array.isArray(d) ? d : (d.sessions ? (Array.isArray(d.sessions) ? d.sessions : Object.values(d.sessions)) : Object.values(d));
  const panes = new Set();
  for (const s of sessions) {
    const sid = s && (s.sessionId || s.sid);
    if (sid) panes.add('bmx-' + String(sid).slice(0, 8));
  }
  const alive = [];
  for (const p of panes) {
    if (spawnSync('tmux', ['has-session', '-t', p]).status === 0) alive.push(p);
  }
  return alive;
}

function killPane(p) {
  if (DRY) return true;
  return spawnSync('tmux', ['kill-session', '-t', p]).status === 0;
}

// ── main ────────────────────────────────────────────────────────────────────────
const bots = isolatedBots();
if (!bots.length) { log('没有 readIsolation=true 的 bot，无事可做。'); process.exit(0); }

const claude = freshClaudeCred();
const codex = freshCodexAuth();
if (claude) log(`claude 凭证来源：${claude.src}（${claude.valid ? '有效' : '⚠️已过期'}，expiresAt=${claude.exp}）`);
else log('⚠️ 找不到任何 claude 凭证来源（keychain / ~/.claude/.credentials.json）——claude bot 将跳过');
if (claude && !claude.valid) log('⚠️ 最新的 claude 凭证也已过期：请先在本机 `claude /login`，再跑本脚本。');

const changed = [];
for (const { appId, cliId } of bots) {
  const isCodex = /codex/i.test(cliId || '');
  if (isCodex) {
    if (!codex) { log(`- ${appId} [codex] 跳过：找不到 ~/.codex/auth.json`); continue; }
    const did = writeCred(codexAuthPath(appId), codex.raw);
    log(`${did ? '✓' : '·'} ${appId} [codex] ${did ? '已更新 auth.json' : '无变化'}`);
    if (did) changed.push(appId);
  } else {
    if (!claude) { log(`- ${appId} [claude] 跳过：无凭证来源`); continue; }
    const did = writeCred(claudeCredPath(appId), claude.raw);
    log(`${did ? '✓' : '·'} ${appId} [claude] ${did ? '已更新 .credentials.json' : '无变化'}`);
    if (did) changed.push(appId);
  }
}

if (!changed.length) { log('\n所有隔离 bot 的凭证均已是最新，未改动。'); process.exit(0); }

if (NO_RESTART) {
  log(`\n已更新 ${changed.length} 个 bot 的凭证（--no-restart：未重启 pane）。`);
  log('注意：已在跑的 pane 仍持旧 token，下次它们【冷启动】才会读到新凭证。');
  process.exit(0);
}

log(`\n冷重启 ${changed.length} 个已更新 bot 的活跃 pane（下条消息冷启动读新凭证）：`);
let killed = 0;
for (const appId of changed) {
  const panes = livePanesFor(appId);
  if (!panes.length) { log(`  ${appId}: 无活跃 pane`); continue; }
  for (const p of panes) {
    const ok = killPane(p);
    log(`  ${appId}: ${ok ? 'killed' : '（kill 失败）'} ${p}`);
    if (ok) killed++;
  }
}
log(`\n完成${DRY ? '（DRY-RUN，未真正改动）' : ''}：更新 ${changed.length} 个 bot，重启 ${killed} 个 pane。`);
