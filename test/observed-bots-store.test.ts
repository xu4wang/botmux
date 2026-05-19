import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  recordObservedBots,
  listObservedBots,
  type ObservedBot,
} from '../src/services/observed-bots-store.js';

let dataDir = '';

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'botmux-observed-bots-'));
});

afterEach(() => {
  if (dataDir) {
    rmSync(dataDir, { recursive: true, force: true });
    dataDir = '';
  }
});

describe('observed-bots-store', () => {
  it('returns empty list when no file exists', () => {
    const out = listObservedBots(dataDir, 'oc_nonexistent');
    expect(out).toEqual([]);
  });

  it('records a single bot and reads it back', () => {
    const t = 1_700_000_000_000;
    recordObservedBots(
      dataDir,
      'oc_chat1',
      [{ openId: 'ou_aaa', name: 'BotA' }],
      'introduce',
      t,
    );
    const out = listObservedBots(dataDir, 'oc_chat1', undefined, t);
    expect(out).toEqual<ObservedBot[]>([
      { openId: 'ou_aaa', name: 'BotA', source: 'introduce', firstSeenAt: t, lastSeenAt: t },
    ]);
  });

  it('writes file at observed-bots-<chatId>.json so chat isolation is enforced by path', () => {
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_aaa', name: 'BotA' }], 'introduce', 1);
    expect(existsSync(join(dataDir, 'observed-bots-oc_chat1.json'))).toBe(true);
    expect(existsSync(join(dataDir, 'observed-bots-oc_chat2.json'))).toBe(false);
  });

  it('does not leak entries across chats', () => {
    const t = 1_700_000_000_000;
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_aaa', name: 'BotA' }], 'introduce', t);
    recordObservedBots(dataDir, 'oc_chat2', [{ openId: 'ou_bbb', name: 'BotB' }], 'introduce', t);
    expect(listObservedBots(dataDir, 'oc_chat1', undefined, t).map(b => b.openId)).toEqual(['ou_aaa']);
    expect(listObservedBots(dataDir, 'oc_chat2', undefined, t).map(b => b.openId)).toEqual(['ou_bbb']);
  });

  it('upserts existing openId: preserves firstSeenAt, updates lastSeenAt and name', () => {
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_aaa', name: 'OldName' }], 'introduce', 1_000);
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_aaa', name: 'NewName' }], 'introduce', 2_000);
    const out = listObservedBots(dataDir, 'oc_chat1', undefined, 2_000);
    expect(out).toEqual<ObservedBot[]>([
      { openId: 'ou_aaa', name: 'NewName', source: 'introduce', firstSeenAt: 1_000, lastSeenAt: 2_000 },
    ]);
  });

  it('records multiple bots in one call', () => {
    const t = 1_700_000_000_000;
    recordObservedBots(
      dataDir,
      'oc_chat1',
      [
        { openId: 'ou_aaa', name: 'BotA' },
        { openId: 'ou_bbb', name: 'BotB' },
      ],
      'introduce',
      t,
    );
    const out = listObservedBots(dataDir, 'oc_chat1', undefined, t).map(b => b.openId).sort();
    expect(out).toEqual(['ou_aaa', 'ou_bbb']);
  });

  it('filters out entries older than maxAgeMs', () => {
    const day = 24 * 60 * 60 * 1000;
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_stale', name: 'Stale' }], 'introduce', 1_000);
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_fresh', name: 'Fresh' }], 'introduce', 1_000 + 50 * day);

    const now = 1_000 + 50 * day;
    const out = listObservedBots(dataDir, 'oc_chat1', 30 * day, now);
    expect(out.map(b => b.openId)).toEqual(['ou_fresh']);
  });

  it('default expiry is 30 days', () => {
    const day = 24 * 60 * 60 * 1000;
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_stale', name: 'Stale' }], 'introduce', 1_000);
    const out = listObservedBots(dataDir, 'oc_chat1', undefined, 1_000 + 31 * day);
    expect(out).toEqual([]);
  });

  it('skips entries with missing openId or name', () => {
    recordObservedBots(
      dataDir,
      'oc_chat1',
      [
        { openId: 'ou_ok', name: 'Good' },
        { openId: '', name: 'NoId' },
        { openId: 'ou_noname', name: '' },
      ],
      'introduce',
      1_000,
    );
    const out = listObservedBots(dataDir, 'oc_chat1', undefined, 1_000).map(b => b.openId).sort();
    expect(out).toEqual(['ou_ok']);
  });

  it('ignores corrupt JSON file (returns empty)', () => {
    writeFileSync(join(dataDir, 'observed-bots-oc_chat1.json'), '{not json');
    expect(listObservedBots(dataDir, 'oc_chat1')).toEqual([]);
  });

  it('writes atomically via tmp + rename (no temp file left behind on success)', () => {
    recordObservedBots(dataDir, 'oc_chat1', [{ openId: 'ou_aaa', name: 'A' }], 'introduce', 1);
    const fp = join(dataDir, 'observed-bots-oc_chat1.json');
    expect(existsSync(fp)).toBe(true);
    expect(existsSync(fp + '.tmp')).toBe(false);
    // JSON shape sanity check
    const json = JSON.parse(readFileSync(fp, 'utf-8'));
    expect(json).toEqual({
      'ou_aaa': { name: 'A', source: 'introduce', firstSeenAt: 1, lastSeenAt: 1 },
    });
  });

  it('no-op when called with empty bots array (does not create file)', () => {
    recordObservedBots(dataDir, 'oc_chat1', [], 'introduce', 1);
    expect(existsSync(join(dataDir, 'observed-bots-oc_chat1.json'))).toBe(false);
  });
});
