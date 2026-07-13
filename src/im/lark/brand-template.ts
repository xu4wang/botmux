import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export interface DirMeta { url?: string; name?: string }

let cache: { path: string; mtimeMs: number; meta: DirMeta } | null = null;

/**
 * `~` 展开。session.workingDir 可能是**字面量** `~/...`：oncall 绑定（oncallChats /
 * defaultOncall）落盘时存的就是原始字符串，而 resolvePinnedWorkingDir 走 oncallEntry
 * 那一支时不展开。别的消费方都自己展开了（session-manager 给 spawn 的 cwd 用 expandHome），
 * 只有这里漏了 —— statSync('~/x') 必然 ENOENT → 读不到 .botmux-dir.json → 角色名丢失。
 */
function expandHome(p: string): string {
  return p === '~' ? homedir()
    : p.startsWith('~/') ? join(homedir(), p.slice(2))
    : p;
}

/** 读取目录元数据 <workingDir>/.botmux-dir.json（mtime 缓存；缺失/损坏 → {}）。 */
export function readDirMeta(workingDir: string): DirMeta {
  const p = join(expandHome(workingDir), '.botmux-dir.json');
  try {
    const st = statSync(p);
    if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs) return cache.meta;
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const meta: DirMeta = {
      url: safeUrl(raw?.url),
      name: safeName(raw?.name),
    };
    cache = { path: p, mtimeMs: st.mtimeMs, meta };
    return meta;
  } catch {
    return {};
  }
}

/**
 * `.botmux-dir.json` 的内容**不可信**：角色名来自用户（「新建角色：XX」），文件本身也只是磁盘上
 * 的任意 JSON。它会被直接拼进卡片脚注的 markdown 链接 `[{cwdName}]({cwdUrl})` —— 不消毒的话：
 *   name = 'role]\n**伪造正文**'  → 击穿链接文本，把伪造内容注入卡片正文
 *   url  = 'https://x) 尾巴'      → 提前闭合链接，同样注入
 *   url  = 'javascript:alert(1)'  → 危险 scheme 原样交给飞书
 * 所以这里**剥离**（而不是转义 —— 不去赌飞书 markdown 的转义语义）。
 */
function safeName(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = safeText(v).trim();
  return s ? s.slice(0, 64) : undefined;
}

/** 链接文本位的通用消毒：剥离 `[` `]` 与换行（两者都能击穿 `[text](url)`）。 */
function safeText(s: string): string {
  return s.replace(/[\r\n]+/g, ' ').replace(/[[\]]/g, '');
}

/** 只放行 http/https，且不得含空白或 `)`（会提前闭合 markdown 链接）。其余一律丢弃 → 链接降级成纯文本。 */
function safeUrl(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return /^https?:\/\/[^\s)<>"'`]+$/i.test(s) ? s : undefined;
}

/**
 * brandLabel 变量替换：{cwdName}（元数据 name → basename）、{cwd}、{cwdUrl}。
 * 仅当模板含 '{' 时激活（存量签名零影响）；替换后空链接 [x]() 降级为纯文本 x。
 *
 * workingDir 先 expandHome 一次，三个变量共用 —— 否则 {cwdName} 的 basename fallback
 * 与 {cwd} 会吐出字面量 `~`（basename('~') === '~'），与 readDirMeta 读的真实目录不一致。
 */
export function renderBrandTemplate(
  brand: string | undefined,
  workingDir: string | undefined,
): string | undefined {
  if (brand === undefined || !brand.includes('{')) return brand;
  const wd = workingDir ? expandHome(workingDir) : '';
  const meta = wd ? readDirMeta(wd) : {};
  // 单趟替换：避免已替换进去的值（如 name 含 '{cwd}' 字面量）被后续 pass 二次替换。
  // 交替顺序 {cwdName} 在 {cwd} 之前，防前缀吞噬。
  // {cwdName}/{cwd} 落在链接的**文本位**，而它们的 fallback 来自**目录路径** —— 目录名本身
  // 就可以含 `]`（`mkdir 'a]b'` 完全合法），照样能击穿 `[...](...)`。所以路径派生的值也要消毒，
  // 不能只消毒 .botmux-dir.json 里的 name。
  const rendered = brand.replace(/\{cwdName\}|\{cwdUrl\}|\{cwd\}/g, (m) =>
    m === '{cwdName}' ? (wd ? (meta.name ?? safeText(basename(wd))) : '')
    : m === '{cwd}' ? safeText(wd)
    : (meta.url ?? ''));
  return rendered.replace(/\[([^\]]*)\]\(\)/g, '$1');
}
