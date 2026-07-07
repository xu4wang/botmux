// test/timezone.test.ts
import { afterEach, describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeScheduleTimeZone,
  scheduleTimeZone,
  isValidTimeZone,
  hostLocalTimeZone,
  zonedWallClockToUtc,
  zonedTomorrowAt,
} from '../src/utils/timezone.js';
import { invalidateGlobalConfigCache } from '../src/global-config.js';

describe('normalizeScheduleTimeZone', () => {
  it('passes through a normal IANA zone', () => {
    expect(normalizeScheduleTimeZone('Asia/Bangkok')).toBe('Asia/Bangkok');
    expect(normalizeScheduleTimeZone('America/New_York')).toBe('America/New_York');
    expect(normalizeScheduleTimeZone('UTC')).toBe('UTC');
  });

  it("falls back to UTC on the 'Etc/Unknown' sentinel (unresolvable host zone)", () => {
    // Node reports 'Etc/Unknown' when the local zone can't be resolved (e.g. TZ='').
    // croner + toLocaleString both REJECT it, which would null cron next-runs and
    // crash schedule listing — so it must normalize to a value every consumer accepts.
    expect(normalizeScheduleTimeZone('Etc/Unknown')).toBe('UTC');
  });

  it('falls back to UTC on empty / nullish', () => {
    expect(normalizeScheduleTimeZone('')).toBe('UTC');
    expect(normalizeScheduleTimeZone(undefined)).toBe('UTC');
    expect(normalizeScheduleTimeZone(null)).toBe('UTC');
  });
});

describe('isValidTimeZone', () => {
  it('accepts real IANA zones', () => {
    expect(isValidTimeZone('Asia/Shanghai')).toBe(true);
    expect(isValidTimeZone('America/Los_Angeles')).toBe(true);
    expect(isValidTimeZone('UTC')).toBe(true);
  });
  it('rejects garbage / empty / the Etc/Unknown sentinel', () => {
    expect(isValidTimeZone('Mars/Phobos')).toBe(false);
    expect(isValidTimeZone('not a zone')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone(undefined)).toBe(false);
    expect(isValidTimeZone(null)).toBe(false);
    expect(isValidTimeZone('Etc/Unknown')).toBe(false);
  });
});

describe('zonedWallClockToUtc — wall-clock in a zone → UTC instant', () => {
  it('Asia/Shanghai (UTC+8, no DST): 09:00 → 01:00Z same day', () => {
    // 2026-07-08 09:00 in Shanghai == 2026-07-08 01:00 UTC.
    expect(zonedWallClockToUtc('Asia/Shanghai', 2026, 7, 8, 9, 0).toISOString())
      .toBe('2026-07-08T01:00:00.000Z');
  });
  it('America/Los_Angeles in July (PDT, UTC-7): 09:00 → 16:00Z', () => {
    expect(zonedWallClockToUtc('America/Los_Angeles', 2026, 7, 8, 9, 0).toISOString())
      .toBe('2026-07-08T16:00:00.000Z');
  });
  it('America/Los_Angeles in January (PST, UTC-8): 09:00 → 17:00Z (DST-correct)', () => {
    expect(zonedWallClockToUtc('America/Los_Angeles', 2026, 1, 8, 9, 0).toISOString())
      .toBe('2026-01-08T17:00:00.000Z');
  });
});

describe('zonedTomorrowAt — "tomorrow HH:MM" in a zone (injected now)', () => {
  // now = 2026-07-07T18:00:00Z → Shanghai 2026-07-08 02:00, LA 2026-07-07 11:00.
  const nowMs = Date.UTC(2026, 6, 7, 18, 0, 0);
  it('Asia/Shanghai: tomorrow (SH date +1) at 09:00 → 2026-07-09T01:00Z', () => {
    expect(zonedTomorrowAt('Asia/Shanghai', 9, 0, nowMs).toISOString())
      .toBe('2026-07-09T01:00:00.000Z');
  });
  it('America/Los_Angeles: tomorrow (LA date +1) at 09:00 → 2026-07-08T16:00Z', () => {
    expect(zonedTomorrowAt('America/Los_Angeles', 9, 0, nowMs).toISOString())
      .toBe('2026-07-08T16:00:00.000Z');
  });
});

describe('scheduleTimeZone — env → config → host precedence', () => {
  const ENV = 'BOTMUX_SCHEDULE_TIMEZONE';
  const savedEnv = process.env[ENV];
  const savedHome = process.env.HOME;

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV]; else process.env[ENV] = savedEnv;
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    invalidateGlobalConfigCache();
  });

  it('env override wins and is returned verbatim', () => {
    process.env[ENV] = 'Asia/Tokyo';
    expect(scheduleTimeZone()).toBe('Asia/Tokyo');
  });

  it('an invalid env value is ignored (falls through past it)', () => {
    process.env[ENV] = 'Not/AZone';
    // With no config override, this must fall back to the host zone (a valid IANA name).
    delete process.env.HOME; // avoid picking up a stray config in a temp/CI home
    invalidateGlobalConfigCache();
    const tz = scheduleTimeZone();
    expect(tz).not.toBe('Not/AZone');
    expect(isValidTimeZone(tz)).toBe(true);
  });

  it('dashboard config (~/.botmux/config.json) is used when no env override', () => {
    delete process.env[ENV];
    const home = mkdtempSync(join(tmpdir(), 'botmux-tz-'));
    mkdirSync(join(home, '.botmux'), { recursive: true });
    writeFileSync(
      join(home, '.botmux', 'config.json'),
      JSON.stringify({ scheduleTimeZone: 'Asia/Bangkok' }),
    );
    process.env.HOME = home;
    invalidateGlobalConfigCache();
    expect(scheduleTimeZone()).toBe('Asia/Bangkok');
  });

  it('falls back to the host local zone when neither env nor config is set', () => {
    delete process.env[ENV];
    const home = mkdtempSync(join(tmpdir(), 'botmux-tz-'));
    process.env.HOME = home; // no config.json in this fresh home
    invalidateGlobalConfigCache();
    expect(scheduleTimeZone()).toBe(hostLocalTimeZone());
  });
});

describe('scheduleTimeZone', () => {
  it('returns a usable IANA zone the scheduler consumers accept (never throws)', () => {
    const tz = scheduleTimeZone();
    expect(typeof tz).toBe('string');
    expect(tz).not.toBe('Etc/Unknown');
    // Must be accepted by Intl (same API croner/toLocaleString rely on).
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)).not.toThrow();
  });
});
