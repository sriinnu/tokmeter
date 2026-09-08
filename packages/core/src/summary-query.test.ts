import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DailyAccumulator } from "./aggregates-store.js";
import { aggregateRecordsByDay } from "./aggregates.js";
import { createSummaryQuery } from "./summary-query.js";
import { TokmeterCore } from "./tokmeter-core.js";
import type { ScanOptions, TokenRecord } from "./types.js";

const NOW = new Date(2026, 8, 8, 12).getTime();
function record(
  day: number,
  project: string,
  provider: TokenRecord["provider"],
  tokens: number,
  cost = 0
): TokenRecord {
  return {
    timestamp: new Date(2026, 8, day, 10).getTime(),
    project,
    provider,
    model: "fixture-model",
    inputTokens: tokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost,
  };
}

const history = [
  record(-32, "archived", "claude-code", 100, 9),
  record(1, "app", "codex", 7, 0.7),
  record(2, "app", "codex", 11, 1.1),
  record(7, "app", "codex", 20, 2),
  record(7, "app", "claude-code", 40, 4),
  record(7, "other", "codex", 80, 8),
];
const current = record(8, "app", "codex", 3);
current.costEligible = false;
current.usage = {
  source: "tool_sqlite",
  inputTokens: "direct",
  outputTokens: "not_exposed",
  cacheReadTokens: "not_exposed",
  cacheWriteTokens: "not_exposed",
  reasoningTokens: "not_exposed",
  cost: "not_exposed",
  notes: ["No trustworthy cost breakdown"],
};

function fixtureCore(includeToday = true) {
  const core = new TokmeterCore({ skipPricing: true });
  const accumulator = new DailyAccumulator("2026-09-08");
  if (includeToday) accumulator.hydrate(aggregateRecordsByDay([current])[0]);
  Object.assign(core, {
    aliases: { app: { display: "renamed-app", hidden: false, tags: [], modifiedBy: "user" } },
    aggregates: new Map(aggregateRecordsByDay(history).map((day) => [day.date, day])),
    todayAccumulator: includeToday ? accumulator : null,
    recentRecords: includeToday ? [current] : [],
    scanMeta: {
      stableThrough: "2026-09-07",
      historySource: "snapshot",
      todayState: "live",
      lastScanAt: NOW,
      warnings: [{ scope: "provider", message: "fixture source warning" }],
      unpricedModels: ["fixture-model"],
      unpricedRecords: 1,
    },
  });
  return core;
}

describe("aggregate summary queries", () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  test.each<[ScanOptions, number]>([
    [{}, 261],
    [{ week: true }, 154],
    [{ month: true }, 161],
    [{ today: true }, 3],
    [{ since: "2026-09-02", until: "2026-09-07", project: "renamed", providers: ["codex"] }, 31],
    [{ project: "app", providers: ["claude-code"] }, 40],
    [{ year: 2025 }, 0],
    [{ project: "absent" }, 0],
  ])("keeps the exact date/project/provider intersection %j", (options, expected) => {
    const core = fixtureCore();
    const before = JSON.stringify(core.getDailyAggregates());
    const summary = core.getSummary(options);
    expect(summary.stats.totalTokens).toBe(expected);
    expect(summary.models.reduce((sum, model) => sum + model.totalTokens, 0)).toBe(expected);
    expect(summary.daily.reduce((sum, day) => sum + day.totalTokens, 0)).toBe(expected);
    expect(summary.projects.reduce((sum, project) => sum + project.totalTokens, 0)).toBe(expected);
    expect(JSON.stringify(core.getDailyAggregates())).toBe(before);
    expect(core.getStats().totalTokens).toBe(261);
  });

  test("keeps sealed-only totals when no recent raw records exist", () => {
    const core = fixtureCore(false);
    expect(core.getSummary({ week: true }).stats.totalTokens).toBe(151);
    expect(core.getSummary({ week: true }).records).toEqual([]);
  });

  test("today's live accumulator replaces a duplicate sealed day before project filtering", () => {
    const core = fixtureCore();
    const staleToday = aggregateRecordsByDay([record(8, "stale-project", "codex", 999)])[0];
    Object.assign(core, {
      aggregates: new Map([...core.getDailyAggregates(), staleToday].map((day) => [day.date, day])),
    });
    expect(core.getSummary({ today: true }).stats.totalTokens).toBe(3);
    expect(core.getSummary({ today: true, project: "stale-project" }).stats.totalTokens).toBe(0);
  });

  test("hidden projects stay in filtered totals but not project lists", () => {
    const core = fixtureCore();
    Object.assign(core, {
      aliases: { app: { display: "app", hidden: true, tags: [], modifiedBy: "user" } },
    });
    const summary = core.getSummary({ week: true, providers: ["codex"] });
    expect(summary.stats.totalTokens).toBe(114);
    expect(summary.projects.map((project) => project.project)).toEqual(["other"]);
  });

  test("preserves unavailable raw cost provenance, frozen costs, and scan metadata", () => {
    const core = fixtureCore();
    const summary = core.getSummary({ week: true, project: "renamed", providers: ["codex"] });
    expect(summary.stats.totalCost).toBeCloseTo(3.1);
    expect(summary.stats.totalRecords).toBe(3);
    expect(summary.records).toEqual([current]);
    expect(summary.records[0]).toBe(current);
    expect(summary.records[0].usage?.cost).toBe("not_exposed");
    expect(summary.meta).toMatchObject({
      unpricedModels: ["fixture-model"],
      unpricedRecords: 1,
      historySource: "snapshot",
      stableThrough: "2026-09-07",
    });
    expect(summary.meta.warnings[0].message).toBe("fixture source warning");
    expect(summary.signals).toBeUndefined();
    expect(core.getSummary().signals).toBeDefined();
  });

  test("calendar week includes the whole first day and does not depend on hours elapsed", () => {
    const query = createSummaryQuery({ week: true }, {}, NOW);
    expect(
      query.matchesRecord({ ...current, timestamp: new Date(2026, 8, 2, 0, 1).getTime() })
    ).toBe(true);
    expect(
      query.matchesRecord({ ...current, timestamp: new Date(2026, 8, 1, 23, 59).getTime() })
    ).toBe(false);
  });

  test("calendar week uses dates across a daylight-saving boundary", () => {
    const query = createSummaryQuery({ week: true }, {}, new Date(2026, 2, 30, 0, 15).getTime());
    expect(
      query.matchesRecord({ ...current, timestamp: new Date(2026, 2, 24, 0, 1).getTime() })
    ).toBe(true);
    expect(
      query.matchesRecord({ ...current, timestamp: new Date(2026, 2, 23, 23, 59).getTime() })
    ).toBe(false);
  });

  test.each([
    { since: "2026-09-07T12:00:00Z" },
    { until: "2026-02-30" },
    { since: "2026-09-08", until: "2026-09-07" },
    { year: 2026.5 },
  ])("rejects unsupported bounds %j", (options) => {
    expect(() => fixtureCore().getSummary(options)).toThrow();
  });
});
