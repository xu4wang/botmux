import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateRoleLibraryPath } from '../src/core/role-library.js';

function setup() {
  const base = mkdtempSync(join(tmpdir(), 'rolelib-'));
  const root = join(base, 'botmux-roles');
  mkdirSync(join(root, 'users', 'ou_x', '产品经理'), { recursive: true });
  return { base, root };
}

describe('validateRoleLibraryPath', () => {
  it('放行根下的角色目录（返回 realpath）', () => {
    const { root } = setup();
    const r = validateRoleLibraryPath(join(root, 'users', 'ou_x', '产品经理'), root);
    expect(r.ok).toBe(true);
  });
  it('拒绝根之外的目录与 .. 穿越', () => {
    const { base, root } = setup();
    expect(validateRoleLibraryPath(base, root).ok).toBe(false);
    expect(validateRoleLibraryPath(join(root, 'users', '..', '..'), root).ok).toBe(false);
  });
  it('拒绝符号链接逃逸', () => {
    const { base, root } = setup();
    const outside = join(base, 'secret'); mkdirSync(outside);
    symlinkSync(outside, join(root, 'evil'));
    const r = validateRoleLibraryPath(join(root, 'evil'), root);
    expect(r).toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝前缀兄弟目录（botmux-roles-evil）', () => {
    const { base, root } = setup();
    mkdirSync(join(base, 'botmux-roles-evil'));
    expect(validateRoleLibraryPath(join(base, 'botmux-roles-evil'), root))
      .toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝不存在的路径与文件', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(join(root, 'nope'), root).ok).toBe(false);
    const f = join(root, 'a.txt'); writeFileSync(f, 'x');
    expect(validateRoleLibraryPath(f, root)).toEqual({ ok: false, error: 'not_a_directory' });
  });
  it('拒绝根目录本身', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath(root, root)).toEqual({ ok: false, error: 'outside_role_library' });
  });
  it('拒绝空串与空白串', () => {
    const { root } = setup();
    expect(validateRoleLibraryPath('', root)).toEqual({ ok: false, error: 'empty_path' });
    expect(validateRoleLibraryPath('   ', root)).toEqual({ ok: false, error: 'empty_path' });
  });
  it('rootOverride 指向不存在的目录 → role_library_missing', () => {
    const { base, root } = setup();
    expect(validateRoleLibraryPath(join(root, 'users'), join(base, 'no-such-root')))
      .toEqual({ ok: false, error: 'role_library_missing' });
  });
});
