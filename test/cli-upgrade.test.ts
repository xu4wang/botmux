import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runUpgradeCommand, type UpgradeDeps } from '../src/cli/upgrade.js';

function makeDeps(): UpgradeDeps & { commands: string[]; output: string[]; envs: NodeJS.ProcessEnv[] } {
  const commands: string[] = [];
  const output: string[] = [];
  const envs: NodeJS.ProcessEnv[] = [];

  return {
    env: { PATH: '/bin' },
    log: line => output.push(line),
    error: line => output.push(line),
    run: (command, args, options) => {
      commands.push([command, ...args].join(' '));
      envs.push(options?.env ?? {});
      return { status: 0 };
    },
    commands,
    output,
    envs,
  };
}

function makeFailingDeps(failAtCommand: string): UpgradeDeps & { commands: string[]; output: string[] } {
  const deps = makeDeps();
  return {
    ...deps,
    run: (command, args, options) => {
      const line = [command, ...args].join(' ');
      deps.commands.push(line);
      deps.envs.push(options?.env ?? {});
      return line === failAtCommand ? { status: 1 } : { status: 0 };
    },
  };
}

describe('botmux upgrade', () => {
  it('upgrades only the CLI by default', async () => {
    const deps = makeDeps();

    const code = await runUpgradeCommand([], deps);

    expect(code).toBe(0);
    expect(deps.commands).toEqual(['npm install -g botmux@latest']);
    expect(deps.output.join('\n')).toContain('运行 botmux restart');
  });

  it('installs the desktop app after CLI upgrade when requested', async () => {
    const deps = makeDeps();

    const code = await runUpgradeCommand(['--with-app', '--app-url', 'https://downloads.example.com/Botmux.zip', '--no-open'], deps);

    expect(code).toBe(0);
    expect(deps.commands).toEqual([
      'npm install -g botmux@latest',
      'botmux app install --no-open',
    ]);
    expect(deps.envs[1]?.BOTMUX_APP_INSTALL_URL).toBe('https://downloads.example.com/Botmux.zip');
    expect(deps.output.join('\n')).toContain('App 更新完成');
  });

  it('requires an app zip URL before starting a --with-app upgrade', async () => {
    const deps = makeDeps();

    const code = await runUpgradeCommand(['--with-app'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual([]);
    expect(deps.output.join('\n')).toContain('--app-url');
  });

  it('points users back to npm when the CLI upgrade stage fails', async () => {
    const deps = makeFailingDeps('npm install -g botmux@latest');

    const code = await runUpgradeCommand(['--with-app', '--app-url', 'https://downloads.example.com/Botmux.zip'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual(['npm install -g botmux@latest']);
    expect(deps.output.join('\n')).toContain('npm install -g botmux@latest');
    expect(deps.output.join('\n')).not.toContain('botmux app install');
  });

  it('points users back to app install when only the app stage fails', async () => {
    const deps = makeFailingDeps('botmux app install');

    const code = await runUpgradeCommand(['--with-app', '--app-url', 'https://downloads.example.com/Botmux.zip'], deps);

    expect(code).toBe(1);
    expect(deps.commands).toEqual([
      'npm install -g botmux@latest',
      'botmux app install',
    ]);
    expect(deps.output.join('\n')).toContain('CLI 可能已经更新');
    expect(deps.output.join('\n')).toContain('botmux app install');
  });

  it('is wired through the top-level CLI dispatcher', () => {
    const cliSource = readFileSync(
      fileURLToPath(new URL('../src/cli.ts', import.meta.url)),
      'utf-8',
    );

    expect(cliSource).toContain('runUpgradeCommand');
    expect(cliSource).toContain('process.argv.slice(3)');
    expect(cliSource).toContain('--with-app');
  });
});
