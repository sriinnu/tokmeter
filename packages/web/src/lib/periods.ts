import type { TokmeterDailyEntry, TokmeterStats } from "../hooks/useTokmeterData.js";
import { addDays, dateRange, localDateKey, startOfMonth, startOfWeek } from "./dates.js";

export type PeriodKey = "today" | "week" | "month" | "all";

export interface PeriodTotals {
  key: PeriodKey;
  cost: number;
  totalTokens: number;
  records: number;
  /** Days in the period that have a ledger entry. */
  activeDays: number;
  /** First and last date key the period covers (all-time: first/last ledger day). */
  start: string | null;
  end: string | null;
  /**
   * The comparable earlier span: the same weekdays of last week, the same
   * days of last month. For today it is yesterday, which is a full day against
   * a partial one — show it as a reference figure, not as a percentage change.
   */
  previous: { cost: number; totalTokens: number; start: string; end: string } | null;
  /** Per-day cost across the period, zero-filled, for a sparkline. */
  series: number[];
}

interface Sum {
  cost: number;
  totalTokens: number;
  records: number;
  activeDays: number;
}

/**
 * Period headline totals derived from the summary's daily ledger.
 *
 * Today/week/month are plain sums of `daily` entries inside the window — the
 * same numbers the daily table shows, added up. All-time comes straight from
 * `stats`, never re-summed, so it always matches the payload's own total.
 */
export function buildPeriodTotals(
  daily: TokmeterDailyEntry[],
  stats: TokmeterStats,
  now: number = Date.now()
): Record<PeriodKey, PeriodTotals> {
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const today = localDateKey(now);

  const sumRange = (start: string, end: string): Sum => {
    const acc: Sum = { cost: 0, totalTokens: 0, records: 0, activeDays: 0 };
    for (const entry of daily) {
      if (entry.date < start || entry.date > end) continue;
      acc.cost += entry.cost;
      acc.totalTokens += entry.totalTokens;
      acc.records += entry.records;
      acc.activeDays += 1;
    }
    return acc;
  };
  const seriesFor = (start: string, end: string): number[] => {
    const days: number[] = [];
    for (let key = start; key <= end; key = addDays(key, 1)) {
      days.push(byDate.get(key)?.cost ?? 0);
    }
    return days;
  };
  const period = (
    key: PeriodKey,
    start: string,
    prevStart: string,
    prevEnd: string
  ): PeriodTotals => {
    const current = sumRange(start, today);
    const prev = sumRange(prevStart, prevEnd);
    return {
      key,
      ...current,
      start,
      end: today,
      previous: { cost: prev.cost, totalTokens: prev.totalTokens, start: prevStart, end: prevEnd },
      series: seriesFor(start, today),
    };
  };

  const yesterday = addDays(today, -1);
  const weekStart = startOfWeek(today);
  const monthStart = startOfMonth(today);
  const prevMonthStart = startOfMonth(addDays(monthStart, -1));
  // Same day-of-month last month, clamped to that month's last day.
  const dayOfMonth = Number(today.slice(8, 10));
  const prevMonthEnd = minKey(addDays(prevMonthStart, dayOfMonth - 1), addDays(monthStart, -1));

  const first = daily[0]?.date ?? null;
  const last = daily[daily.length - 1]?.date ?? null;

  return {
    today: period("today", today, yesterday, yesterday),
    week: period("week", weekStart, addDays(weekStart, -7), addDays(today, -7)),
    month: period("month", monthStart, prevMonthStart, prevMonthEnd),
    all: {
      key: "all",
      cost: stats.totalCost,
      totalTokens: stats.totalTokens,
      records: stats.totalRecords,
      activeDays: stats.activeDays,
      start: first,
      end: last,
      previous: null,
      series: last ? dateRange(maxKey(last, today), 30).map((k) => byDate.get(k)?.cost ?? 0) : [],
    },
  };
}

function minKey(a: string, b: string): string {
  return a < b ? a : b;
}

function maxKey(a: string, b: string): string {
  return a > b ? a : b;
}
