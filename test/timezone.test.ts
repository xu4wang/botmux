// test/timezone.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeScheduleTimeZone, scheduleTimeZone } from '../src/utils/timezone.js';

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

describe('scheduleTimeZone', () => {
  it('returns a usable IANA zone the scheduler consumers accept (never throws)', () => {
    const tz = scheduleTimeZone();
    expect(typeof tz).toBe('string');
    expect(tz).not.toBe('Etc/Unknown');
    // Must be accepted by Intl (same API croner/toLocaleString rely on).
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(0)).not.toThrow();
  });
});
