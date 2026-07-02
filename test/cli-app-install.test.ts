import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runAppCommand, type AppInstallDeps } from '../src/cli/app-install.js';

function makeDeps(existingPaths: string[]): AppInstallDeps & { commands: string[]; output: string[]; writes: string[] } {
  const commands: string[] = [];
  const output: string[] = [];
  const writes: string[] = [];
  const existing = new Set(existingPaths);

  return {
    platform: 'darwin',
    arch: 'arm64',
    projectRoot: '/repo',
    tmpRoot: '/tmp/botmux-app-install',
    env: { PATH: '/opt/homebrew/bin:/usr/bin:/bin' },
    exists: path => existing.has(path),
    writeFile: (path, content) => writes.push(`${path}:${content.length}`),
    resolveAppVersion: () => '2.96.0',
    log: line => output.push(line),
    error: line => output.push(line),
    run: (command, args) => {
      commands.push([command, ...args].join(' '));
      return { status: 0 };
    },
    runCapture: (command, args) => ({
      status: 1,
      stdout: '',
      stderr: `unexpected capture: ${[command, ...args].join(' ')}`,
    }),
    commands,
    output,
    writes,
  };
}

function mockLinkedGlobalCli(
  deps: ReturnType<typeof makeDeps> & { realpath?: (path: string) => string },
  root = '/repo',
): void {
  deps.runCapture = (command, args) => {
    const key = [command, ...args].join(' ');
    if (key === 'pnpm bin -g') {
      return { status: 0, stdout: '/opt/homebrew/bin\n', stderr: '' };
    }
    if (key === '/bin/zsh -lc command -v botmux') {
      return { status: 0, stdout: '/opt/homebrew/bin/botmux\n', stderr: '' };
    }
    if (key === 'botmux --version') {
      return { status: 0, stdout: '2.96.0\n', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: key };
  };
  deps.readFile = path => path === '/opt/homebrew/bin/botmux'
    ? '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../../../repo/dist/cli.js" "$@"\n'
    : '';
  deps.realpath = path => path === root ? root : path;
}

describe('botmux app install', () => {
  it('downloads, ad-hoc signs, installs, and verifies the macOS app by default', async () => {
    const deps = makeDeps(['/tmp/botmux-app-install/extract/Botmux.app']);
    deps.env.BOTMUX_APP_INSTALL_URL = 'https://downloads.example.com/Botmux-mac-arm64.zip';

    const code = await runAppCommand(['install', '--no-open'], deps);

    expect(code).toBe(0);
    expect(deps.commands).toEqual([
      'rm -rf /tmp/botmux-app-install',
      'mkdir -p /tmp/botmux-app-install/extract',
      'curl -L --fail --show-error --output /tmp/botmux-app-install/Botmux.zip https://downloads.example.com/Botmux-mac-arm64.zip',
      'ditto -x -k /tmp/botmux-app-install/Botmux.zip /tmp/botmux-app-install/extract',
      'osascript -e tell application "Botmux" to quit',
      'codesign --force --deep --sign - --options runtime --entitlements /tmp/botmux-app-install/entitlements.mac.plist /tmp/botmux-app-install/extract/Botmux.app',
      'rm -rf /Applications/Botmux.app',
      'ditto /tmp/botmux-app-install/extract/Botmux.app /Applications/Botmux.app',
      'xattr -dr com.apple.quarantine /Applications/Botmux.app',
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app',
    ]);
    expect(deps.writes[0]).toContain('/tmp/botmux-app-install/entitlements.mac.plist');
    expect(deps.output.join('\n')).toContain('下载');
  });

  it('requires a download URL for non-source installs', async () => {
    const deps = makeDeps([]);

    const code = await runAppCommand(['install'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual([]);
    expect(deps.output.join('\n')).toContain('BOTMUX_APP_INSTALL_URL');
  });

  it('builds, ad-hoc signs, installs, and verifies the local macOS app from source', async () => {
    const deps = makeDeps([
      '/repo/package.json',
      '/repo/src/desktop/main.ts',
      '/repo/electron-builder.yml',
      '/repo/build/entitlements.mac.plist',
      '/repo/node_modules/.bin/tsc',
      '/repo/dist/mac-arm64/Botmux.app',
    ]);
    mockLinkedGlobalCli(deps);

    const code = await runAppCommand(['install', '--from-source', '--no-open'], deps);

    expect(code).toBe(0);
    expect(deps.commands).toEqual([
      'pnpm build',
      'pnpm link --global',
      'pnpm desktop:bundle',
      'pnpm exec electron-builder --mac dir --config electron-builder.yml',
      'plutil -replace CFBundleShortVersionString -string 2.96.0 /repo/dist/mac-arm64/Botmux.app/Contents/Info.plist',
      'plutil -replace CFBundleVersion -string 2.96.0 /repo/dist/mac-arm64/Botmux.app/Contents/Info.plist',
      'osascript -e tell application "Botmux" to quit',
      'codesign --force --deep --sign - --options runtime --entitlements /repo/build/entitlements.mac.plist /repo/dist/mac-arm64/Botmux.app',
      'rm -rf /Applications/Botmux.app',
      'ditto /repo/dist/mac-arm64/Botmux.app /Applications/Botmux.app',
      'xattr -dr com.apple.quarantine /Applications/Botmux.app',
      'codesign --verify --deep --strict --verbose=2 /Applications/Botmux.app',
    ]);
    expect(deps.output.join('\n')).toContain('ad-hoc');
    expect(deps.output.join('\n')).toContain('Desktop 版本 2.96.0');
    expect(deps.output.join('\n')).toContain('全局 CLI');
  });

  it('fails source installs when the global botmux command still points elsewhere', async () => {
    const deps = makeDeps([
      '/repo/package.json',
      '/repo/src/desktop/main.ts',
      '/repo/electron-builder.yml',
      '/repo/build/entitlements.mac.plist',
      '/repo/node_modules/.bin/tsc',
      '/repo/dist/mac-arm64/Botmux.app',
    ]) as ReturnType<typeof makeDeps> & {
      realpath: (path: string) => string;
    };

    deps.runCapture = (command, args) => {
      const key = [command, ...args].join(' ');
      if (key === 'pnpm bin -g') {
        return { status: 0, stdout: '/opt/homebrew/bin\n', stderr: '' };
      }
      if (key === '/bin/zsh -lc command -v botmux') {
        return { status: 0, stdout: '/opt/homebrew/bin/botmux\n', stderr: '' };
      }
      if (key === 'botmux --version') {
        return { status: 0, stdout: '2.95.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: key };
    };
    deps.readFile = path => path === '/opt/homebrew/bin/botmux'
      ? '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../../../Users/me/.nvm/versions/node/v22/lib/node_modules/botmux/dist/cli.js" "$@"\n'
      : '';
    deps.realpath = path => path;

    const code = await runAppCommand(['install', '--from-source', '--no-open'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual([
      'pnpm build',
      'pnpm link --global',
    ]);
    expect(deps.output.join('\n')).toContain('全局 botmux 未指向当前源码仓库');
  });

  it('fails before linking when pnpm global-bin-dir is outside PATH', async () => {
    const deps = makeDeps([
      '/repo/package.json',
      '/repo/src/desktop/main.ts',
      '/repo/electron-builder.yml',
      '/repo/build/entitlements.mac.plist',
      '/repo/node_modules/.bin/tsc',
      '/repo/dist/mac-arm64/Botmux.app',
    ]);
    deps.runCapture = (command, args) => {
      const key = [command, ...args].join(' ');
      if (key === 'pnpm bin -g') {
        return { status: 0, stdout: '/Users/me/Library/pnpm/bin\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: key };
    };

    const code = await runAppCommand(['install', '--from-source', '--no-open'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual(['pnpm build']);
    expect(deps.output.join('\n')).toContain('pnpm global-bin-dir 不在 PATH');
  });

  it('allows a slower global CLI startup while verifying source installs', async () => {
    const deps = makeDeps([
      '/repo/package.json',
      '/repo/src/desktop/main.ts',
      '/repo/electron-builder.yml',
      '/repo/build/entitlements.mac.plist',
      '/repo/node_modules/.bin/tsc',
      '/repo/dist/mac-arm64/Botmux.app',
    ]);
    let versionTimeout: number | undefined;
    deps.runCapture = (command, args, options) => {
      const key = [command, ...args].join(' ');
      if (key === 'pnpm bin -g') return { status: 0, stdout: '/opt/homebrew/bin\n', stderr: '' };
      if (key === '/bin/zsh -lc command -v botmux') return { status: 0, stdout: '/opt/homebrew/bin/botmux\n', stderr: '' };
      if (key === 'botmux --version') {
        versionTimeout = options?.timeout;
        return { status: 0, stdout: '2.96.0\n', stderr: '' };
      }
      return { status: 1, stdout: '', stderr: key };
    };
    deps.readFile = path => path === '/opt/homebrew/bin/botmux'
      ? '#!/bin/sh\nbasedir=$(dirname "$0")\nexec node "$basedir/../../../repo/dist/cli.js" "$@"\n'
      : '';
    deps.realpath = path => path === '/repo' ? '/repo' : path;

    const code = await runAppCommand(['install', '--from-source', '--no-open', '--skip-build'], deps);

    expect(code).toBe(0);
    expect(versionTimeout).toBeGreaterThanOrEqual(15_000);
  });

  it('rejects source installs outside the botmux repository', async () => {
    const deps = makeDeps(['/repo/package.json']);

    const code = await runAppCommand(['install', '--from-source'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual([]);
    expect(deps.output.join('\n')).toContain('需要在 botmux 源码仓库');
  });

  it('is exposed from the top-level CLI help and dispatcher', () => {
    const cliSource = readFileSync(
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'utf-8',
    );

    expect(cliSource).toContain('app install');
    expect(cliSource).toContain("case 'app'");
  });

  it('dispatches botmux app smoke through the shared app command', async () => {
    const deps = makeDeps([
      '/Applications/Botmux.app',
      '/Applications/Botmux.app/Contents/MacOS/Botmux',
      '/Applications/Botmux.app/Contents/Info.plist',
      '/Applications/Botmux.app/Contents/Resources/app.asar',
    ]);
    deps.env.BOTMUX_DASHBOARD_URL = 'http://127.0.0.1:7891';
    deps.runCapture = (command, args) => {
      const key = [command, ...args].join(' ');
      if (key.startsWith('plutil ')) return { status: 0, stdout: '2.96.0\n', stderr: '' };
      if (key.startsWith('codesign ')) return { status: 0, stdout: '', stderr: '' };
      if (key === 'botmux status') return { status: 0, stdout: 'running\n', stderr: '' };
      if (key.startsWith('curl ')) {
        return {
          status: 0,
          stdout: JSON.stringify({ schemaVersion: 1, product: 'botmux', runtimeVersion: '2.96.0', dashboardProtocolVersion: 1 }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: key };
    };

    const code = await runAppCommand(['smoke'], deps);

    expect(code).toBe(0);
    expect(deps.output.join('\n')).toContain('smoke passed');
  });
});
