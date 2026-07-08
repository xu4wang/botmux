/**
 * 用户定时任务(scheduler)统一使用的时区 = 主机的系统本地时区。
 *
 * 背景:cron 触发与各处显示历史上写死 'Asia/Shanghai',而一次性「明天HH:MM」用
 * `Date.setHours()` 走系统本地时间,两者在非 +8 主机上错开一个时差(用户报的
 * “有时本地有时东8”)。改走本函数后,cron 触发、CLI/卡片显示、dashboard next-run
 * 预览都跟随系统本地时区,与一次性解析保持一致。
 *
 * 以函数(而非常量)导出:每次调用实时解析,便于测试注入,也不把值冻结在模块导入期。
 * 注:维护窗口(maintenance-schedule.ts 的 MAINTENANCE_TZ)是独立子系统,刻意不走这里。
 */

/**
 * 把 `Intl.DateTimeFormat().resolvedOptions().timeZone` 解析出的原始值归一成一个
 * **一定能被 croner / `toLocaleString({ timeZone })` 接受** 的 IANA 名。
 *
 * 边界:某些主机(如 `TZ` 被导出成空串)下 Node 会把本地时区报成哨兵 `Etc/Unknown`,
 * 它既不是合法 IANA 名 —— croner 会抛 `Invalid timezone` 让 cron next-run 变 null、
 * `toLocaleString` 会抛 RangeError 让定时任务列表渲染崩。这类不可用值一律回退到 UTC
 * (对所有消费方都合法、且确定性)。纯函数,便于单测。
 */
export function normalizeScheduleTimeZone(raw: string | undefined | null): string {
  if (!raw || raw === 'Etc/Unknown') return 'UTC';
  return raw;
}

/** 主机系统本地时区(经 Intl 解析,遵循 TZ 环境变量),已归一为可用 IANA 名。 */
export function scheduleTimeZone(): string {
  return normalizeScheduleTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}
