/**
 * Local-calendar date keys (YYYY-MM-DD in the browser timezone), matching
 * core's localDateKey convention so "today" here is the same day the ledger
 * calls today.
 */
export function localDateKey(ts: number | Date): string {
  const d = ts instanceof Date ? ts : new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Parse a date key at local midnight. Invalid keys yield an Invalid Date. */
export function parseDateKey(key: string): Date {
  return new Date(`${key}T00:00:00`);
}

/** Shift a date key by whole calendar days (DST-safe: works on the calendar, not ms). */
export function addDays(key: string, days: number): string {
  const d = parseDateKey(key);
  d.setDate(d.getDate() + days);
  return localDateKey(d);
}

/** Inclusive run of consecutive date keys ending at `endKey`. */
export function dateRange(endKey: string, count: number): string[] {
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) out.push(addDays(endKey, -i));
  return out;
}

/** Monday of the week containing `key` (ISO week start). */
export function startOfWeek(key: string): string {
  const d = parseDateKey(key);
  return addDays(key, -((d.getDay() + 6) % 7));
}

/** First day of the month containing `key`. */
export function startOfMonth(key: string): string {
  return `${key.slice(0, 8)}01`;
}
