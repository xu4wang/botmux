export interface SpawnCommand {
  command: string;
  args: string[];
}

export function buildPm2SpawnCommand(
  pm2Script: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
  nodePath: string = process.execPath,
): SpawnCommand {
  if (platform === 'win32' && pm2Script !== 'pm2') {
    return { command: nodePath, args: [pm2Script, ...args] };
  }
  return { command: pm2Script, args };
}
