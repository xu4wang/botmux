/**
 * 用户定时任务(scheduler)统一使用的时区。
 *
 * 解析优先级（scheduleTimeZone）：
 *   1. `BOTMUX_SCHEDULE_TIMEZONE` 环境变量（逃生阀/显式覆盖，与其它设置一致）
 *   2. dashboard 配置 `~/.botmux/config.json` 的 `scheduleTimeZone`（用户在 Settings 页填写）
 *   3. 主机系统本地时区（`Intl.DateTimeFormat().resolvedOptions().timeZone`，遵循 `TZ`）
 *
 * 背景：cron 触发与各处显示历史上写死 'Asia/Shanghai'，而一次性「明天HH:MM」用
 * `Date.setHours()` 走系统本地时间，两者在非 +8 主机上错开一个时差。改走本函数后，
 * cron 触发、一次性「明天」解析、CLI/卡片显示、dashboard next-run 预览全部跟随同一个
 * 解析结果。默认跟主机时区（没有别的可靠办法确定用户时区）；主机时区被误配/不是用户
 * 想要的时区时，可在 dashboard 里显式指定（例如主机是 America/Los_Angeles 但用户在
 * 北京，填 `Asia/Shanghai` 即可）。
 *
 * 以函数（而非常量）导出：每次调用实时解析，便于测试注入，也不把值冻结在模块导入期。
 * 注：维护窗口(maintenance-schedule.ts 的 MAINTENANCE_TZ)是独立子系统，刻意不走这里。
 */

import { readGlobalConfig } from '../global-config.js';

/**
 * 把 `Intl.DateTimeFormat().resolvedOptions().timeZone` 解析出的原始值归一成一个
 * **一定能被 croner / `toLocaleString({ timeZone })` 接受** 的 IANA 名。
 *
 * 边界：某些主机（如 `TZ` 被导出成空串）下 Node 会把本地时区报成哨兵 `Etc/Unknown`，
 * 它既不是合法 IANA 名 —— croner 会抛 `Invalid timezone` 让 cron next-run 变 null、
 * `toLocaleString` 会抛 RangeError 让定时任务列表渲染崩。这类不可用值一律回退到 UTC
 * （对所有消费方都合法、且确定性）。纯函数，便于单测。
 */
export function normalizeScheduleTimeZone(raw: string | undefined | null): string {
  if (!raw || raw === 'Etc/Unknown') return 'UTC';
  return raw;
}

/**
 * 校验 `tz` 是否是一个 **croner / Intl 都能接受** 的合法 IANA 名。用于：
 *   - dashboard 写入前校验用户填的值（非法则拒绝，返回 invalid_scheduleTimeZone）
 *   - scheduleTimeZone() 解析时兜底（配置/env 里若是非法值，跳过、回退主机时区）
 */
export function isValidTimeZone(tz: string | undefined | null): boolean {
  if (!tz || tz === 'Etc/Unknown') return false;
  try {
    // Throws RangeError on an unknown/malformed zone — same check croner relies on.
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 主机系统本地时区（经 Intl 解析，遵循 TZ 环境变量），已归一为可用 IANA 名。 */
export function hostLocalTimeZone(): string {
  return normalizeScheduleTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

/**
 * 定时任务统一使用的时区。优先级：env → dashboard 配置 → 主机本地时区。
 * 每一层都经过 `isValidTimeZone` 校验，非法值直接跳到下一层，保证返回的一定是可用
 * IANA 名（最终兜底 `hostLocalTimeZone()` 里的 `Etc/Unknown → UTC`）。
 */
export function scheduleTimeZone(): string {
  const envTz = process.env.BOTMUX_SCHEDULE_TIMEZONE?.trim();
  if (envTz && isValidTimeZone(envTz)) return envTz;

  const configured = readGlobalConfig().scheduleTimeZone;
  if (configured && isValidTimeZone(configured)) return configured;

  return hostLocalTimeZone();
}

// ─── tz-aware wall-clock ↔ instant helpers ─────────────────────────────────
// 一次性「明天HH:MM」这类**挂钟时间**的解析需要「某时区的某个墙上时刻 → UTC 瞬时」
// 的换算。JS 原生只有 `Date.setHours()`（走主机本地时区），在非目标时区的主机上会算错。
// 下面用 Intl.formatToParts 计算目标时区在给定瞬时的 UTC 偏移，纯函数、无第三方依赖。

/**
 * 目标时区 `tz` 在 UTC 瞬时 `utcMs` 处，需要「加到 UTC 上」得到当地墙上时间的偏移(ms)。
 * 即 `当地墙上时间ms = utcMs + tzOffsetMs(tz, utcMs)`（UTC 以东为正）。
 */
function tzOffsetMs(tz: string, utcMs: number): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(utcMs))) {
    if (p.type !== 'literal') f[p.type] = Number(p.value);
  }
  // 把 tz 当地墙上字段「当作 UTC」拼回一个瞬时，与真实 utcMs 的差就是偏移。
  const asIfUtc = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute, f.second);
  return asIfUtc - utcMs;
}

/**
 * 把「时区 `tz` 下的墙上时间 (year, month, day, hour, minute)」换算成对应的 UTC Date。
 * 用一次偏移修正处理 DST 边界（偏移在 guess 瞬时与结果瞬时不同的情形）。
 */
export function zonedWallClockToUtc(
  tz: string,
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
  const offset = tzOffsetMs(tz, guess);
  let utc = guess - offset;
  // guess 与最终瞬时可能落在 DST 切换两侧、偏移不同 —— 再修正一次即收敛。
  const offset2 = tzOffsetMs(tz, utc);
  if (offset2 !== offset) utc = guess - offset2;
  return new Date(utc);
}

/**
 * 「明天 HH:MM」（时区 `tz` 下）对应的 UTC Date。「明天」= `tz` 里今天日期的次日。
 * `nowMs` 可注入以便单测；默认取当前时刻。
 */
export function zonedTomorrowAt(
  tz: string,
  hour: number,
  minute: number,
  nowMs: number = Date.now(),
): Date {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const f: Record<string, number> = {};
  for (const p of dtf.formatToParts(new Date(nowMs))) {
    if (p.type !== 'literal') f[p.type] = Number(p.value);
  }
  // 次日：用 Date.UTC 仅做日历进位归一（跨月/跨年），不当瞬时用。
  const nextCal = new Date(Date.UTC(f.year, f.month - 1, f.day + 1));
  return zonedWallClockToUtc(
    tz,
    nextCal.getUTCFullYear(),
    nextCal.getUTCMonth() + 1,
    nextCal.getUTCDate(),
    hour,
    minute,
  );
}
