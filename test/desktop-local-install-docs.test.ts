import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('desktop local source installer docs', () => {
  it('keeps Desktop installation outside the botmux CLI command surface', () => {
    const script = readFileSync('src/desktop/install-local.sh', 'utf-8');
    const readme = readFileSync('src/desktop/README.md', 'utf-8');

    expect(script).toContain('#!/usr/bin/env bash');
    expect(script).toContain('Node.js 22 or newer is required');
    expect(script).toContain('resolve_app_version');
    expect(script).toContain('BOTMUX_DESKTOP_VERSION');
    expect(script).toContain('-c.extraMetadata.version="$APP_VERSION"');
    expect(script).toContain('ensure_pnpm_global_bin_in_path');
    expect(script).toContain('$HOME/Library/pnpm/bin');
    expect(script).toContain('pnpm link --global');
    expect(script).toContain('pnpm use:here');
    expect(script).toContain('pnpm desktop:bundle');
    expect(script).toContain('electron-builder --mac dir');
    expect(script).toContain('codesign --force --deep --sign -');
    expect(script).toContain('xattr -dr com.apple.quarantine');
    expect(script).not.toContain('botmux app');

    expect(readme).toContain('bash src/desktop/install-local.sh');
    expect(readme).toContain('pnpm link --global');
    expect(readme).toContain('~/.botmux/bin/botmux');
    expect(readme).toContain('BOTMUX_DESKTOP_VERSION');
    expect(readme).not.toContain('botmux app');
  });
});
