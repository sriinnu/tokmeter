/**
 * View-model for the "Today" 24-hour dial, built from the summary's raw
 * records window — the same records and the same local-date/hour bucketing
 * buildDashboardInsights uses for its hourly buckets, so every hour here
 * matches the Bars and Table views exactly.
 */

export const DIAL_TOP_MODELS = 4;
export const MIN_TYPICAL_DAYS = 3;
export const OTHER_KEY = "other";

interface RawRecord {
  timestamp?: number;
  model?: string;
  provider?: string;
  cost?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}

export interface DialSeries {
  key: string;
  label: string;
  provider: string | null;
  /** Today's total for this series, in the dial's measure. */
  value: number;
}

export interface DialModelShare {
  key: string;
  label: string;
  cost: number;
  totalTokens: number;
}

export interface DialHour {
  hour: number;
  cost: number;
  totalTokens: number;
  records: number;
  /** Per-series value in the dial's measure, in series order; sums to `value`. */
  segments: Array<{ key: string; value: number }>;
  /** The hour's measure (cost, or tokens on an all-unpriced day). */
  value: number;
  /** Models active this hour, largest first. */
  models: DialModelShare[];
}

export interface TodayDial {
  /** "cost" normally; "tokens" when nothing today has a price. */
  measure: "cost" | "tokens";
  hours: DialHour[];
  series: DialSeries[];
  /** Sum of the 24 hours, in the dial's measure. */
  total: number;
  totalCost: number;
  max: number;
}

export interface TypicalDay {
  /** Median of each local hour across the window's earlier days, in the dial's measure. */
  values: number[];
  days: number;
}

const tokensOf = (r: RawRecord) =>
  (r.inputTokens ?? 0) +
  (r.outputTokens ?? 0) +
  (r.cacheReadTokens ?? 0) +
  (r.cacheWriteTokens ?? 0) +
  (r.reasoningTokens ?? 0);

export function buildTodayDial(
  records: Array<Record<string, unknown>>,
  todayKey: string,
  toDateKey: (ts: number) => string
): TodayDial {
  const today = (records as RawRecord[]).filter(
    (r) => typeof r.timestamp === "number" && toDateKey(r.timestamp) === todayKey
  );
  const measure: "cost" | "tokens" =
    today.every((r) => (r.cost ?? 0) === 0) && today.some((r) => tokensOf(r) > 0)
      ? "tokens"
      : "cost";
  const measureOf = (r: RawRecord) => (measure === "cost" ? (r.cost ?? 0) : tokensOf(r));
  const modelKey = (r: RawRecord) => `${r.provider ?? ""}::${r.model ?? ""}`;

  const totals = new Map<
    string,
    { label: string; provider: string; value: number; tokens: number }
  >();
  for (const r of today) {
    const key = modelKey(r);
    const t = totals.get(key) ?? {
      label: r.model ?? "unknown",
      provider: r.provider ?? "",
      value: 0,
      tokens: 0,
    };
    t.value += measureOf(r);
    t.tokens += tokensOf(r);
    totals.set(key, t);
  }
  // Same ranking as the "Models today" list: by the measure, tokens as tie-break.
  const ranked = [...totals.entries()].sort(
    ([, a], [, b]) => b.value - a.value || b.tokens - a.tokens
  );
  const top = ranked.slice(0, DIAL_TOP_MODELS);
  const series: DialSeries[] = top.map(([key, t]) => ({
    key,
    label: t.label,
    provider: t.provider,
    value: t.value,
  }));
  const rest = ranked.slice(DIAL_TOP_MODELS);
  if (rest.length > 0) {
    series.push({
      key: OTHER_KEY,
      label: `Other (${rest.length})`,
      provider: null,
      value: rest.reduce((s, [, t]) => s + t.value, 0),
    });
  }
  const seriesOf = (key: string) => (top.some(([k]) => k === key) ? key : OTHER_KEY);

  const hours: DialHour[] = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    cost: 0,
    totalTokens: 0,
    records: 0,
    value: 0,
    segments: series.map((s) => ({ key: s.key, value: 0 })),
    models: [],
  }));
  const perHourModels = Array.from({ length: 24 }, () => new Map<string, DialModelShare>());
  for (const r of today) {
    const bucket = hours[new Date(r.timestamp as number).getHours()];
    const v = measureOf(r);
    bucket.cost += r.cost ?? 0;
    bucket.totalTokens += tokensOf(r);
    bucket.records += 1;
    bucket.value += v;
    const segment = bucket.segments.find((s) => s.key === seriesOf(modelKey(r)));
    if (segment) segment.value += v;
    const models = perHourModels[bucket.hour];
    const key = modelKey(r);
    const m = models.get(key) ?? { key, label: r.model ?? "unknown", cost: 0, totalTokens: 0 };
    m.cost += r.cost ?? 0;
    m.totalTokens += tokensOf(r);
    models.set(key, m);
  }
  for (const bucket of hours) {
    bucket.models = [...perHourModels[bucket.hour].values()].sort(
      (a, b) => b.cost - a.cost || b.totalTokens - a.totalTokens
    );
  }

  return {
    measure,
    hours,
    series,
    total: hours.reduce((s, h) => s + h.value, 0),
    totalCost: hours.reduce((s, h) => s + h.cost, 0),
    max: Math.max(0, ...hours.map((h) => h.value)),
  };
}

/**
 * "Typical day" ring: for each local hour, the median across the earlier days
 * in the records window that have any data (today excluded). Quiet hours on
 * those days count as zero — that is what a typical hour looks like. Fewer
 * than MIN_TYPICAL_DAYS days is not a typical day, so it returns null.
 */
export function buildTypicalDay(
  records: Array<Record<string, unknown>>,
  todayKey: string,
  toDateKey: (ts: number) => string,
  measure: "cost" | "tokens"
): TypicalDay | null {
  const byDay = new Map<string, number[]>();
  for (const raw of records as RawRecord[]) {
    if (typeof raw.timestamp !== "number") continue;
    const day = toDateKey(raw.timestamp);
    if (day >= todayKey) continue;
    let hours = byDay.get(day);
    if (!hours) {
      hours = new Array<number>(24).fill(0);
      byDay.set(day, hours);
    }
    hours[new Date(raw.timestamp).getHours()] +=
      measure === "cost" ? (raw.cost ?? 0) : tokensOf(raw);
  }
  const days = [...byDay.values()];
  if (days.length < MIN_TYPICAL_DAYS) return null;
  const values = Array.from({ length: 24 }, (_, hour) => {
    const column = days.map((d) => d[hour]).sort((a, b) => a - b);
    const mid = Math.floor(column.length / 2);
    return column.length % 2 ? column[mid] : (column[mid - 1] + column[mid]) / 2;
  });
  return { values, days: days.length };
}
