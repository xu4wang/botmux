import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

export interface DirMeta { url?: string; name?: string }

let cache: { path: string; mtimeMs: number; meta: DirMeta } | null = null;

/** 读取目录元数据 <workingDir>/.botmux-dir.json（mtime 缓存；缺失/损坏 → {}）。 */
export function readDirMeta(workingDir: string): DirMeta {
  const p = join(workingDir, '.botmux-dir.json');
  try {
    const st = statSync(p);
    if (cache && cache.path === p && cache.mtimeMs === st.mtimeMs) return cache.meta;
    const raw = JSON.parse(readFileSync(p, 'utf-8'));
    const meta: DirMeta = {
      url: typeof raw?.url === 'string' ? raw.url : undefined,
      name: typeof raw?.name === 'string' ? raw.name : undefined,
    };
    cache = { path: p, mtimeMs: st.mtimeMs, meta };
    return meta;
  } catch {
    return {};
  }
}

/**
 * brandLabel 变量替换：{cwdName}（元数据 name → basename）、{cwd}、{cwdUrl}。
 * 仅当模板含 '{' 时激活（存量签名零影响）；替换后空链接 [x]() 降级为纯文本 x。
 */
export function renderBrandTemplate(
  brand: string | undefined,
  workingDir: string | undefined,
): string | undefined {
  if (brand === undefined || !brand.includes('{')) return brand;
  const wd = workingDir ?? '';
  const meta = wd ? readDirMeta(wd) : {};
  // 单趟替换：避免已替换进去的值（如 name 含 '{cwd}' 字面量）被后续 pass 二次替换。
  // 交替顺序 {cwdName} 在 {cwd} 之前，防前缀吞噬。
  const rendered = brand.replace(/\{cwdName\}|\{cwdUrl\}|\{cwd\}/g, (m) =>
    m === '{cwdName}' ? (wd ? (meta.name ?? basename(wd)) : '')
    : m === '{cwd}' ? wd
    : (meta.url ?? ''));
  return rendered.replace(/\[([^\]]*)\]\(\)/g, '$1');
}
