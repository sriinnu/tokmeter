import { addDays, startOfWeek } from "./dates.js";
import type { DayState } from "./day-state.js";
import type { DailyPoint } from "./series.js";

/** Above this many days a bar per day is unreadable; roll up to weeks. */
export const WEEKLY_THRESHOLD_DAYS = 180;

export interface ChartPoint extends DailyPoint {
  /** Last day the point covers (same as `date` for a daily point). */
  end: string;
  /** Days of the range inside this point (1 for daily, up to 7 weekly). */
  days: number;
  /** A week cut short by the range edge (fewer than 7 days in range). */
  partial: boolean;
  granularity: "day" | "week";
}

const SUM_KEYS = [
  "cost",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "records",
] as const;

// The least settled day decides the week: a week containing today is live,
// one containing an unsealed day is pending, only all-sealed weeks are sealed.
const STATE_RANK: Record<DayState, number> = { sealed: 0, pending: 1, snapshot: 2, live: 3 };

export function asDailyPoints(points: DailyPoint[]): ChartPoint[] {
  return points.map((p) => ({ ...p, end: p.date, days: 1, partial: false, granularity: "day" }));
}

/**
 * ISO weeks (Monday start) as exact sums of the same zero-filled daily points
 * the daily chart uses — no re-derivation, so the weekly bars add up to the
 * same window total. Weeks cut by the range edges are marked partial.
 */
export function rollupWeekly(points: DailyPoint[]): ChartPoint[] {
  const weeks = new Map<string, ChartPoint>();
  for (const p of points) {
    const key = startOfWeek(p.date);
    let week = weeks.get(key);
    if (!week) {
      week = {
        ...p,
        date: key,
        end: addDays(key, 6),
        days: 0,
        partial: false,
        granularity: "week",
        hasEntry: false,
        state: "sealed",
      };
      for (const k of SUM_KEYS) week[k] = 0;
      weeks.set(key, week);
    }
    for (const k of SUM_KEYS) week[k] += p[k];
    week.days += 1;
    week.hasEntry ||= p.hasEntry;
    if (STATE_RANK[p.state] > STATE_RANK[week.state]) week.state = p.state;
  }
  return [...weeks.values()].map((w) => ({ ...w, partial: w.days < 7 }));
}

/** Daily points as-is up to the threshold, weekly beyond it. */
export function toChartPoints(points: DailyPoint[]): ChartPoint[] {
  return points.length > WEEKLY_THRESHOLD_DAYS ? rollupWeekly(points) : asDailyPoints(points);
}
