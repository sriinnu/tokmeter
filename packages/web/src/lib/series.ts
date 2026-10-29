import type {
  TokmeterDailyEntry,
  TokmeterProjectSummary,
  TokmeterScanMeta,
} from "../hooks/useTokmeterData.js";
import { dateRange } from "./dates.js";
import { type DayState, getDayState } from "./day-state.js";

export interface DailyPoint {
  date: string;
  state: DayState;
  cost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  records: number;
  /** False for a zero-filled calendar day that has no ledger entry. */
  hasEntry: boolean;
}

/**
 * A consecutive, zero-filled run of days ending at `endKey`.
 *
 * Quiet days are real data — dropping them would compress the time axis and
 * make bursts look like steady use. Each point copies its ledger entry
 * verbatim; nothing is recomputed.
 */
export function buildDailySeries(
  daily: TokmeterDailyEntry[],
  windowDays: number,
  endKey: string,
  todayKey: string,
  meta: TokmeterScanMeta
): DailyPoint[] {
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  return dateRange(endKey, windowDays).map((date) => {
    const entry = byDate.get(date);
    return {
      date,
      state: getDayState(date, todayKey, meta),
      cost: entry?.cost ?? 0,
      totalTokens: entry?.totalTokens ?? 0,
      inputTokens: entry?.inputTokens ?? 0,
      outputTokens: entry?.outputTokens ?? 0,
      cacheReadTokens: entry?.cacheReadTokens ?? 0,
      cacheWriteTokens: entry?.cacheWriteTokens ?? 0,
      reasoningTokens: entry?.reasoningTokens ?? 0,
      records: entry?.records ?? 0,
      hasEntry: entry !== undefined,
    };
  });
}

/** Days between the first ledger day and `endKey`, inclusive, capped. */
export function spanDays(daily: TokmeterDailyEntry[], endKey: string, cap: number): number {
  const first = daily[0]?.date;
  if (!first) return 1;
  const ms = new Date(`${endKey}T00:00:00`).getTime() - new Date(`${first}T00:00:00`).getTime();
  return Math.max(1, Math.min(cap, Math.round(ms / 86_400_000) + 1));
}

export type Metric = "cost" | "tokens";

export interface Matrix {
  rows: string[];
  cols: string[];
  /** values[row][col] */
  values: number[][];
  max: number;
  /** Sum of every cell shown. */
  shownTotal: number;
  /** Sum the cells were drawn from, so omitted rows can be stated honestly. */
  sourceTotal: number;
  /** Rows that exist in the source but were left out (beyond the top N). */
  omittedRows: number;
}

/**
 * Day × project grid from each project's own daily ledger.
 *
 * Rows are the top projects by the chosen metric inside the window; the rest
 * are left out and counted in `omittedRows` rather than folded into an
 * invented "other" row.
 */
export function buildDayProjectMatrix(
  projects: TokmeterProjectSummary[],
  dates: string[],
  metric: Metric,
  topN: number
): Matrix {
  const pick = (entry: TokmeterDailyEntry) => (metric === "cost" ? entry.cost : entry.totalTokens);
  const first = dates[0];
  const last = dates[dates.length - 1];
  const index = new Map(dates.map((date, i) => [date, i]));

  const rows = projects
    .map((project) => {
      const values = new Array<number>(dates.length).fill(0);
      for (const entry of project.dailyBreakdown) {
        if (entry.date < first || entry.date > last) continue;
        const i = index.get(entry.date);
        if (i !== undefined) values[i] += pick(entry);
      }
      return { label: project.project, values, total: values.reduce((s, v) => s + v, 0) };
    })
    .filter((row) => row.total > 0)
    .sort((a, b) => b.total - a.total);

  const shown = rows.slice(0, topN);
  return {
    rows: shown.map((row) => row.label),
    cols: dates,
    values: shown.map((row) => row.values),
    max: Math.max(0, ...shown.flatMap((row) => row.values)),
    shownTotal: shown.reduce((s, row) => s + row.total, 0),
    sourceTotal: rows.reduce((s, row) => s + row.total, 0),
    omittedRows: Math.max(0, rows.length - shown.length),
  };
}

interface HourRecord {
  timestamp?: number;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

/**
 * Day × local-hour grid from the summary's raw records window.
 *
 * The summary only carries records for a rolling recent window (~14 days), so
 * this grid can only cover those days. Token totals use the same five buckets
 * core sums for `totalTokens`; `cacheWrite1hTokens` is a subset of
 * `cacheWriteTokens` and is deliberately not read.
 */
export function buildDayHourMatrix(
  records: Array<Record<string, unknown>>,
  dates: string[],
  metric: Metric,
  toDateKey: (ts: number) => string
): Matrix {
  const index = new Map(dates.map((date, i) => [date, i]));
  const values = dates.map(() => new Array<number>(24).fill(0));
  let total = 0;
  for (const raw of records) {
    const r = raw as HourRecord;
    if (typeof r.timestamp !== "number") continue;
    const row = index.get(toDateKey(r.timestamp));
    if (row === undefined) continue;
    const value =
      metric === "cost"
        ? (r.cost ?? 0)
        : (r.inputTokens ?? 0) +
          (r.outputTokens ?? 0) +
          (r.cacheReadTokens ?? 0) +
          (r.cacheWriteTokens ?? 0) +
          (r.reasoningTokens ?? 0);
    values[row][new Date(r.timestamp).getHours()] += value;
    total += value;
  }
  return {
    rows: dates,
    cols: Array.from({ length: 24 }, (_, hour) => String(hour)),
    values,
    max: Math.max(0, ...values.flat()),
    shownTotal: total,
    sourceTotal: total,
    omittedRows: 0,
  };
}

/** Earliest local date present in the raw records window, if any. */
export function recordsWindowStart(
  records: Array<Record<string, unknown>>,
  toDateKey: (ts: number) => string
): string | null {
  let min = Number.POSITIVE_INFINITY;
  for (const raw of records) {
    const ts = (raw as HourRecord).timestamp;
    if (typeof ts === "number" && ts < min) min = ts;
  }
  return Number.isFinite(min) ? toDateKey(min) : null;
}

/** Sequential bin (0..steps-1) for a value; 0 is reserved for exactly zero. */
export function binFor(value: number, max: number, steps: number): number {
  if (value <= 0 || max <= 0) return 0;
  return Math.min(steps - 1, 1 + Math.floor((value / max) * (steps - 1 - 1e-9)));
}
