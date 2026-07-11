import { realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** 角色库根：v0 固定约定，不做配置。 */
export function roleLibraryRoot(): string {
  return join(homedir(), 'botmux-roles');
}

/** 文件系统身份包含判断（dev+ino）：从 childReal 逐级向上，某祖先与 rootReal 同一目录即包含。
 *  不依赖字符串大小写语义——大小写敏感/不敏感卷、darwin/linux 行为一致。
 *  childReal === rootReal 时首个检查从其父目录开始，天然拒绝根本身。 */
function isContainedIn(childReal: string, rootReal: string): boolean {
  const root = statSync(rootReal);
  let cur = childReal;
  while (true) {
    const parent = dirname(cur);
    if (parent === cur) return false;
    const st = statSync(parent);
    if (st.dev === root.dev && st.ino === root.ino) return true;
    cur = parent;
  }
}

/**
 * botmux cd 的目标目录硬校验（调用方是模型，不可信）：
 * realpath 归一化（防 ../ 与符号链接逃逸）→ 必须位于角色库根之下
 * （文件系统身份 dev+ino 比较，防前缀兄弟目录与大小写变体绕过）→ 必须是已存在的目录。
 */
export function validateRoleLibraryPath(
  input: string,
  rootOverride?: string,
): { ok: true; resolvedPath: string } | { ok: false; error: string } {
  const raw = (input ?? '').trim();
  if (!raw) return { ok: false, error: 'empty_path' };
  let rootReal: string;
  try { rootReal = realpathSync(rootOverride ?? roleLibraryRoot()); }
  catch { return { ok: false, error: 'role_library_missing' }; }
  let real: string;
  try { real = realpathSync(raw); }
  catch { return { ok: false, error: 'dir_not_found' }; }
  if (!isContainedIn(real, rootReal)) return { ok: false, error: 'outside_role_library' };
  try { if (!statSync(real).isDirectory()) return { ok: false, error: 'not_a_directory' }; }
  catch { return { ok: false, error: 'dir_not_found' }; }
  return { ok: true, resolvedPath: real };
}
