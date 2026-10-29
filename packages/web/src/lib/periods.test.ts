import { describe, expect, it } from "vitest";
import type { TokmeterDailyEntry, TokmeterStats } from "../hooks/useTokmeterData.js";
import { buildPeriodTotals } from "./periods.js";

function day(date: string, cost: number, totalTokens = cost * 100): TokmeterDailyEntry {
  return {
    date,
    cost,
    totalTokens,
    inputTokens: totalTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    records: 1,
  };
}

const stats = {
  totalCost: 999,
  totalTokens: 123_456,
  totalRecords: 42,
  activeDays: 9,
} as TokmeterStats;

// Thursday 15 Oct 2026, local midday — far from midnight so no runner's
// timezone can push it onto another calendar day.
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();

const daily = [
  day("2026-09-10", 7), // previous month, inside the same-days window (1st–15th)
  day("2026-09-20", 50), // previous month, after the 15th: excluded from the comparison
  day("2026-10-01", 1),
  day("2026-10-05", 2), // Monday of last week
  day("2026-10-08", 4), // Thursday of last week (same weekday as today)
  day("2026-10-09", 8), // Friday of last week: past the comparable span
  day("2026-10-12", 16), // Monday this week
  day("2026-10-14", 32), // yesterday
  day("2026-10-15", 64), // today
];

describe("buildPeriodTotals", () => {
  const periods = buildPeriodTotals(daily, stats, NOW);

  it("sums today, week-to-date and month-to-date from ledger entries", () => {
    expect(periods.today.cost).toBe(64);
    expect(periods.week.cost).toBe(16 + 32 + 64);
    expect(periods.month.cost).toBe(1 + 2 + 4 + 8 + 16 + 32 + 64);
    expect(periods.week.start).toBe("2026-10-12");
    expect(periods.month.start).toBe("2026-10-01");
  });

  it("compares like-for-like spans, never a partial period against a full one", () => {
    expect(periods.today.previous).toMatchObject({ cost: 32, start: "2026-10-14" });
    expect(periods.week.previous).toMatchObject({
      cost: 2 + 4,
      start: "2026-10-05",
      end: "2026-10-08",
    });
    expect(periods.month.previous).toMatchObject({
      cost: 7,
      start: "2026-09-01",
      end: "2026-09-15",
    });
  });

  it("takes all-time straight from stats instead of re-summing daily", () => {
    expect(periods.all.cost).toBe(999);
    expect(periods.all.totalTokens).toBe(123_456);
    expect(periods.all.activeDays).toBe(9);
  });

  it("zero-fills sparkline series across quiet days", () => {
    expect(periods.week.series).toEqual([16, 0, 32, 64]);
    expect(periods.all.series).toHaveLength(30);
  });

  it("clamps last month's comparison end to that month's length", () => {
    const march31 = new Date(2026, 2, 31, 12, 0, 0).getTime();
    const result = buildPeriodTotals([day("2026-02-28", 5), day("2026-03-31", 1)], stats, march31);
    expect(result.month.previous).toMatchObject({
      start: "2026-02-01",
      end: "2026-02-28",
      cost: 5,
    });
  });
});
