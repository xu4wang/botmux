import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { renderBrandTemplate } from '../src/im/lark/brand-template.js';

describe('renderBrandTemplate', () => {
  it('不含 { 的模板原样返回（含 undefined/空串/默认值）', () => {
    expect(renderBrandTemplate(undefined, '/tmp/x')).toBeUndefined();
    expect(renderBrandTemplate('', '/tmp/x')).toBe('');
    expect(renderBrandTemplate('[botmux](https://github.com/deepcoldy/botmux)', '/tmp/x'))
      .toBe('[botmux](https://github.com/deepcoldy/botmux)');
  });

  it('{cwdName} 取目录 basename，{cwd} 取全路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    expect(renderBrandTemplate('{cwdName}', dir)).toBe(basename(dir));
    expect(renderBrandTemplate('{cwd}', dir)).toBe(dir);
  });

  it('.botmux-dir.json 的 name 覆盖 basename、url 填充 {cwdUrl}', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: '售后客服', url: 'https://x.feishu.cn/docx/abc' }));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe('[售后客服](https://x.feishu.cn/docx/abc)');
  });

  it('workingDir 以 ~ 开头时展开成 home 再读 .botmux-dir.json（oncall 绑定存的就是字面量 ~）', () => {
    // 复现：resolvePinnedWorkingDir 走 oncallEntry.workingDir 那一支时不展开 ~，
    // 字面量 `~/...` 直接流到这里；Node 的 fs 不认 ~ → statSync ENOENT → 角色名丢失。
    // 其它消费方（session-manager.ts spawn 的 cwd）都 expandHome 了，只有这里漏了。
    const home = homedir();
    const dir = mkdtempSync(join(home, '.brand-tilde-'));
    try {
      writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: '默认助理', url: 'https://x.feishu.cn/docx/abc' }));
      const tilde = `~/${basename(dir)}`;             // 字面量 ~，正是 oncall 绑定里存的形态
      expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', tilde)).toBe('[默认助理](https://x.feishu.cn/docx/abc)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // ── codex review 抓出的 4 条（均已复现）──────────────────────────────
  it('name/url 是不可信输入：剥离 []、换行，拒绝非 http(s) 与含 ) 的 url（防卡片注入）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-inj-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({
      name: 'role]\n**伪造正文**',
      url: 'https://safe.example/x) 后续正文',
    }));
    const out = renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)!;
    expect(out).not.toContain('**伪造正文**]');   // 链接文本没被击穿
    expect(out).not.toContain('\n');
    expect(out).toBe('role **伪造正文**');          // url 非法 → 丢弃 → 空链接降级成纯文本
  });

  it('目录名本身含 ] 时也要消毒（basename fallback / {cwd} 同样落在链接文本位）', () => {
    // `mkdir 'a]b'` 完全合法 —— 没有 .botmux-dir.json 时 {cwdName} 回落到 basename(wd)，
    // 目录名里的 ] 照样能击穿 [text](url)。
    const dir = mkdtempSync(join(tmpdir(), 'brand-]evil-'));
    const out = renderBrandTemplate('[{cwdName}](https://x.example/)', dir)!;
    expect(out).toContain('](https://x.example/)');       // 链接结构完好
    expect(out.split('](https://x.example/)')[0]).not.toContain(']');  // 文本位没有裸 ]
    expect(renderBrandTemplate('{cwd}', dir)).not.toContain(']');
  });

  it('javascript: 等危险 scheme 一律丢弃', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-js-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'x', url: 'javascript:alert(1)' }));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe('x');
  });

  it('workingDir 恰好是 `~` 时，{cwdName} 取 home 的 basename 而不是字面量 ~', () => {
    expect(renderBrandTemplate('{cwdName}', '~')).toBe(basename(homedir()));
  });

  it('{cwd} 输出展开后的绝对路径，不是字面量 ~/...', () => {
    expect(renderBrandTemplate('{cwd}', '~/foo')).toBe(join(homedir(), 'foo'));
  });

  it('url 缺失时空链接降级为纯文本', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', dir)).toBe(basename(dir));
  });

  it('workingDir 为 undefined 时变量替换为空串并降级', () => {
    expect(renderBrandTemplate('[{cwdName}]({cwdUrl})', undefined)).toBe('');
  });

  it('元文件损坏时按不存在处理', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), '{not json');
    expect(renderBrandTemplate('{cwdName}', dir)).toBe(basename(dir));
  });

  it('替换进去的值含变量字面量时不被二次替换', () => {
    const dir = mkdtempSync(join(tmpdir(), 'brand-'));
    writeFileSync(join(dir, '.botmux-dir.json'), JSON.stringify({ name: 'foo{cwd}bar' }));
    expect(renderBrandTemplate('{cwdName}', dir)).toBe('foo{cwd}bar');
  });
});
