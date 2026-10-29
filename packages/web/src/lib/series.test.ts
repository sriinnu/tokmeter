import { describe, expect, it } from "vitest";
import type { TokmeterProjectSummary, TokmeterScanMeta } from "../hooks/useTokmeterData.js";
import { localDateKey } from "./dates.js";
import { getDayState } from "./day-state.js";
import { binFor, buildDailySeries, buildDayHourMatrix, buildDayProjectMatrix } from "./series.js";

const meta: TokmeterScanMeta = {
  stableThrough: "2026-10-13",
  historySource: "snapshot",
  todayState: "live",
  lastScanAt: 0,
  warnings: [],
};

function entry(date: string, cost: number, totalTokens: number) {
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

function project(name: string, days: Array<[string, number]>): TokmeterProjectSummary {
  return {
    project: name,
    dailyBreakdown: days.map(([date, cost]) => entry(date, cost, cost * 10)),
  } as TokmeterProjectSummary;
}

describe("getDayState", () => {
  it("separates sealed history, the live day and unsealed gaps", () => {
    expect(getDayState("2026-10-13", "2026-10-15", meta)).toBe("sealed");
    expect(getDayState("2026-10-14", "2026-10-15", meta)).toBe("pending");
    expect(getDayState("2026-10-15", "2026-10-15", meta)).toBe("live");
    expect(getDayState("2026-10-15", "2026-10-15", { ...meta, todayState: "degraded" })).toBe(
      "snapshot"
    );
  });
});

describe("buildDailySeries", () => {
  it("zero-fills quiet days and copies ledger entries verbatim", () => {
    const series = buildDailySeries(
      [entry("2026-10-12", 1.5, 100), entry("2026-10-15", 3, 300)],
      4,
      "2026-10-15",
      "2026-10-15",
      meta
    );
    expect(series.map((p) => [p.date, p.cost, p.hasEntry, p.state])).toEqual([
      ["2026-10-12", 1.5, true, "sealed"],
      ["2026-10-13", 0, false, "sealed"],
      ["2026-10-14", 0, false, "pending"],
      ["2026-10-15", 3, true, "live"],
    ]);
  });
});

describe("buildDayProjectMatrix", () => {
  const dates = ["2026-10-13", "2026-10-14", "2026-10-15"];
  const projects = [
    project("small", [["2026-10-14", 1]]),
    project("big", [
      ["2026-10-01", 500], // outside the window
      ["2026-10-13", 10],
      ["2026-10-15", 20],
    ]),
    project("mid", [["2026-10-15", 5]]),
    project("idle", [["2026-09-01", 9]]),
  ];

  it("ranks rows by in-window total and states what was left out", () => {
    const matrix = buildDayProjectMatrix(projects, dates, "cost", 2);
    expect(matrix.rows).toEqual(["big", "mid"]);
    expect(matrix.values).toEqual([
      [10, 0, 20],
      [0, 0, 5],
    ]);
    expect(matrix.max).toBe(20);
    expect(matrix.shownTotal).toBe(35);
    expect(matrix.sourceTotal).toBe(36);
    expect(matrix.omittedRows).toBe(1);
  });

  it("reads tokens instead of cost when asked", () => {
    expect(buildDayProjectMatrix(projects, dates, "tokens", 5).values[0]).toEqual([100, 0, 200]);
  });
});

describe("buildDayHourMatrix", () => {
  it("buckets raw records by local hour using exactly the five token buckets", () => {
    const at = (h: number) => new Date(2026, 9, 15, h, 30).getTime();
    const records = [
      {
        timestamp: at(9),
        cost: 0.5,
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 100,
        cacheWriteTokens: 40,
        // A subset of cacheWriteTokens; adding it would double count.
        cacheWrite1hTokens: 40,
        reasoningTokens: 2,
      },
      { timestamp: at(9), cost: 0.25, inputTokens: 1 },
      { timestamp: at(23), cost: 1, inputTokens: 3 },
      { timestamp: new Date(2026, 9, 1, 12).getTime(), cost: 99, inputTokens: 99 },
    ];
    const dates = ["2026-10-15"];
    const tokens = buildDayHourMatrix(records, dates, "tokens", localDateKey);
    expect(tokens.values[0][9]).toBe(158);
    expect(tokens.values[0][23]).toBe(3);
    expect(tokens.shownTotal).toBe(161);
    const cost = buildDayHourMatrix(records, dates, "cost", localDateKey);
    expect(cost.values[0][9]).toBe(0.75);
    expect(cost.max).toBe(1);
  });
});

describe("binFor", () => {
  it("reserves bin 0 for zero and maps the max to the top bin", () => {
    expect(binFor(0, 10, 8)).toBe(0);
    expect(binFor(0.0001, 10, 8)).toBe(1);
    expect(binFor(10, 10, 8)).toBe(7);
  });
});
