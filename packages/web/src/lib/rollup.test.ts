import { describe, expect, it } from "vitest";
import type { TokmeterDailyEntry, TokmeterScanMeta } from "../hooks/useTokmeterData.js";
import { rollupWeekly, toChartPoints } from "./rollup.js";
import { buildDailySeries, spanDays } from "./series.js";

const meta: TokmeterScanMeta = {
  stableThrough: "2026-10-13",
  historySource: "snapshot",
  todayState: "live",
  lastScanAt: 0,
  warnings: [],
};

function entry(date: string, seed: number): TokmeterDailyEntry {
  return {
    date,
    cost: seed * 1.37,
    totalTokens: seed * 1000 + 15,
    inputTokens: seed * 300,
    outputTokens: seed * 200,
    cacheReadTokens: seed * 400,
    cacheWriteTokens: seed * 100 + 15,
    reasoningTokens: 0,
    records: seed,
  };
}

// A year of irregular activity ending on Thursday 15 Oct 2026 (mid-week, so
// the last week is partial), starting on a Wednesday (first week partial).
const daily: TokmeterDailyEntry[] = [];
for (let i = 0, d = new Date(2025, 9, 15, 12); i < 366; i++, d.setDate(d.getDate() + 1)) {
  if (i % 3 === 1) continue;
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  daily.push(entry(key, (i % 11) + 1));
}
const today = "2026-10-15";
const sum = (rows: Array<Record<string, unknown>>, key: string) =>
  rows.reduce((s, r) => s + (r[key] as number), 0);
const KEYS = [
  "cost",
  "totalTokens",
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "records",
];

describe("rollupWeekly", () => {
  for (const [label, days] of [
    ["all-time range", spanDays(daily, today, 10_000)],
    ["181-day range", 181],
    ["30-day range", 30],
  ] as const) {
    it(`keeps every total equal to the daily totals (${label})`, () => {
      const points = buildDailySeries(daily, days, today, today, meta);
      const weeks = rollupWeekly(points);
      for (const key of KEYS) {
        expect(sum(weeks as never, key)).toBeCloseTo(sum(points as never, key), 9);
      }
      expect(sum(weeks as never, "days")).toBe(points.length);
    });
  }

  it("starts weeks on Monday and marks only edge weeks partial", () => {
    const points = buildDailySeries(daily, spanDays(daily, today, 10_000), today, today, meta);
    const weeks = rollupWeekly(points);
    for (const w of weeks) expect(new Date(`${w.date}T12:00:00`).getDay()).toBe(1);
    expect(weeks[0].partial).toBe(true);
    expect(weeks[weeks.length - 1]).toMatchObject({ partial: true, days: 4, state: "live" });
    expect(weeks.slice(1, -1).every((w) => !w.partial && w.days === 7)).toBe(true);
    // Unsealed days after stableThrough sit in the live week; earlier weeks are sealed.
    expect(weeks[weeks.length - 2].state).toBe("sealed");
  });

  it("switches to weekly only above 180 days", () => {
    expect(toChartPoints(buildDailySeries(daily, 180, today, today, meta))[0].granularity).toBe(
      "day"
    );
    expect(toChartPoints(buildDailySeries(daily, 181, today, today, meta))[0].granularity).toBe(
      "week"
    );
  });
});
