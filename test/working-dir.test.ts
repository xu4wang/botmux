import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configuredWorkingDirs, invalidWorkingDirs, normalizeWorkingDirInput, parseWorkingDirList } from '../src/utils/working-dir.js';
import { expandHome, validateWorkingDir } from '../src/core/working-dir.js';

describe('working-dir utils', () => {
  it('parses comma-separated strings and arrays', () => {
    expect(parseWorkingDirList('/a, /b,,/c')).toEqual(['/a', '/b', '/c']);
    expect(parseWorkingDirList(['/a, /b', ' /c '])).toEqual(['/a', '/b', '/c']);
    expect(parseWorkingDirList(undefined)).toEqual([]);
  });

  it('dedupes configured dirs by resolved path', () => {
    const cwd = process.cwd();
    expect(configuredWorkingDirs({ workingDir: '., ' + cwd })).toEqual(['.']);
  });

  it('expands ~/ paths to the user home directory', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/docai')).toBe(join(homedir(), 'docai'));
    expect(validateWorkingDir('~').ok).toBe(true);
  });

  it('normalizes setup workingDir input without changing relative path semantics', () => {
    expect(normalizeWorkingDirInput('')).toBe('~');
    expect(normalizeWorkingDirInput('', '/repo/current')).toBe('/repo/current');
    expect(normalizeWorkingDirInput('docai/docai-oncall')).toBe('docai/docai-oncall');
    expect(normalizeWorkingDirInput('~/docai')).toBe('~/docai');
    expect(normalizeWorkingDirInput('/srv/docai')).toBe('/srv/docai');
  });

  it('reports missing paths and files as invalid dirs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'botmux-working-dir-'));
    const file = join(dir, 'not-a-dir');
    const missing = join(dir, 'missing');
    writeFileSync(file, 'x');

    expect(invalidWorkingDirs({ workingDir: [dir, file, missing] })).toEqual([
      resolve(file),
      resolve(missing),
    ]);
  });
});
