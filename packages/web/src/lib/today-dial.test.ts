import { describe, expect, it } from "vitest";
import type { LiveData } from "../hooks/useLiveData.js";
import type { TokmeterData } from "../hooks/useTokmeterData.js";
import { buildDashboardInsights } from "../pages/dashboard/buildDashboardInsights.js";
import { localDateKey } from "./dates.js";
import { buildTodayDial, buildTypicalDay, OTHER_KEY } from "./today-dial.js";

const now = new Date();
const at = (dayOffset: number, hour: number, minute = 10) =>
  new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset, hour, minute).getTime();
const rec = (ts: number, model: string, cost: number, input = 100) => ({
  timestamp: ts,
  model,
  provider: "p",
  project: "x",
  cost,
  inputTokens: input,
  outputTokens: 10,
  cacheReadTokens: 50,
  cacheWriteTokens: 5,
  cacheWrite1hTokens: 5, // subset of cacheWriteTokens: must not be added
  reasoningTokens: 1,
});

const todayRecords = [
  rec(at(0, 1), "a", 0.5),
  rec(at(0, 1, 40), "b", 0.25),
  rec(at(0, 9), "c", 1.2),
  rec(at(0, 9), "d", 0.1),
  rec(at(0, 9), "e", 0.05),
  rec(at(0, 9), "f", 0.01),
  rec(at(0, 13), "a", 2),
];
const todayKey = localDateKey(now);

function insightsFor(records: Array<Record<string, unknown>>) {
  const data = {
    records,
    projects: [],
    models: [],
    daily: [],
    stats: {
      totalTokens: 0,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalRecords: 0,
      projects: 0,
      models: 0,
      providers: 0,
      activeDays: 0,
      longestStreak: 0,
      firstUsed: 0,
      lastUsed: 0,
    },
    meta: {
      stableThrough: null,
      historySource: "none",
      todayState: "live",
      lastScanAt: 0,
      warnings: [],
    },
  } as unknown as TokmeterData;
  const live: LiveData = { status: "disconnected", aggregated: null, lastUpdate: null };
  return buildDashboardInsights(data, live);
}

describe("buildTodayDial", () => {
  it("matches buildDashboardInsights' hourly buckets hour for hour", () => {
    const dial = buildTodayDial(todayRecords, todayKey, localDateKey);
    const hourly = insightsFor(todayRecords).today.hourly;
    for (let h = 0; h < 24; h++) {
      expect(dial.hours[h].cost).toBeCloseTo(hourly[h].cost, 12);
      expect(dial.hours[h].totalTokens).toBe(hourly[h].totalTokens);
      expect(dial.hours[h].records).toBe(hourly[h].records);
    }
    expect(dial.total).toBeCloseTo(
      hourly.reduce((s, h) => s + h.cost, 0),
      12
    );
    expect(dial.measure).toBe("cost");
  });

  it("stacks the top four models plus Other, and segments sum to each hour", () => {
    const dial = buildTodayDial(todayRecords, todayKey, localDateKey);
    expect(dial.series.map((s) => s.label)).toEqual(["a", "c", "b", "d", "Other (2)"]);
    expect(dial.series[4].key).toBe(OTHER_KEY);
    for (const hour of dial.hours) {
      expect(hour.segments.reduce((s, x) => s + x.value, 0)).toBeCloseTo(hour.value, 12);
    }
    expect(dial.hours[9].segments.find((s) => s.key === OTHER_KEY)?.value).toBeCloseTo(0.06, 12);
  });

  it("switches to tokens only when nothing today is priced", () => {
    const unpriced = todayRecords.map((r) => ({ ...r, cost: 0 }));
    const dial = buildTodayDial(unpriced, todayKey, localDateKey);
    expect(dial.measure).toBe("tokens");
    expect(dial.hours[13].value).toBe(100 + 10 + 50 + 5 + 1);
  });
});

describe("buildTypicalDay", () => {
  const history = [
    rec(at(-1, 9), "a", 1),
    rec(at(-2, 9), "a", 3),
    rec(at(-3, 9), "a", 2),
    rec(at(-3, 14), "a", 4),
    rec(at(-4, 22), "a", 9), // a fourth day with nothing at 9am
  ];

  it("takes the per-hour median across earlier days, quiet hours as zero, excluding today", () => {
    const typical = buildTypicalDay([...history, ...todayRecords], todayKey, localDateKey, "cost");
    expect(typical?.days).toBe(4);
    expect(typical?.values[9]).toBe(1.5); // [0, 1, 2, 3]
    expect(typical?.values[14]).toBe(0); // [0, 0, 0, 4]
    expect(typical?.values[13]).toBe(0); // today's 1pm doesn't count
  });

  it("is hidden with fewer than three days of history", () => {
    expect(
      buildTypicalDay([...history.slice(0, 2), ...todayRecords], todayKey, localDateKey, "cost")
    ).toBeNull();
  });
});
