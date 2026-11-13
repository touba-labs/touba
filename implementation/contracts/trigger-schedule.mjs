/** Canonical interval grammar shared by authoring and execution. */
export function parseTriggerRunnerSchedule(value) {
  if (typeof value !== 'string') return { ok: false, reason: 'schedule_not_text' };
  const match = /^every ([1-9][0-9]*)(s|m|h|d)$/u.exec(value.trim());
  if (!match) return { ok: false, reason: 'unsupported_interval_format' };
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount)) return { ok: false, reason: 'interval_not_safe_integer' };
  const delayMs = amount * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  if (!Number.isSafeInteger(delayMs) || delayMs > 2147483647) return { ok: false, reason: 'interval_exceeds_timer_limit' };
  return { ok: true, delayMs, interval: { amount, unit: match[2] } };
}
