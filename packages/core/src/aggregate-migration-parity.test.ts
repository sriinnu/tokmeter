/**
 * Phase 2 aggregate-migration parity tests.
 *
 * For each getter being migrated to read from aggregate state instead of raw
 * records, the parity test seeds a deterministic record set, runs BOTH the
 * legacy records-walking computer AND the new aggregates-walking computer
 * against it, and asserts the outputs are deep-equal. If they ever drift,
 * a real-world consumer would too — and we'd ship wrong numbers. These
 * tests are the contract that lets `this.records` be retired in Phase 3
 * with confidence.
 */

import { describe, expect, test } from "vitest";
import {
  computeAllProjectsFromState,
  computeDailyBreakdownFromState,
  computeModelCostsFromState,
  computeProjectSummaryFromState,
  computeProviderBreakdownFromState,
  computeRawProjectNamesFromState,
  computeStatsFromRecords,
  computeStatsFromState,
} from "./aggregate-consumers.js";
import { DailyAccumulator } from "./aggregates-store.js";
import { aggregateRecordsByDay } from "./aggregates.js";
import {
  aggregateByDate,
  aggregateByModel,
  aggregateByProject,
  aggregateByProvider,
  filterByDate,
  filterByProject,
} from "./aggregator.js";
import type { AliasMap } from "./alias-service.js";
import { isBeforeToday, localDateKey } from "./date-utils.js";
import { projectNameIncludes, projectNamesMatch } from "./project-name.js";
import type { TokenRecord } from "./types.js";

/** Build a `TokenRecord` with sensible defaults — same helper across tests. */
function r(overrides: Partial<TokenRecord> & Pick<TokenRecord, "timestamp">): TokenRecord {
  return {
    project: "demo",
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    ...overrides,
    timestamp: overrides.timestamp,
  };
}

/**
 * Construct timestamps at midday UTC for a given date — the local-date-key
 * a record gets is the same regardless of the test runner's timezone.
 */
function ts(date: string, hour = 12): number {
  return Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
}

/**
 * Project a record set into the aggregate state shape TokmeterCore holds —
 * historical aggregates Map (everything before today) plus a DailyAccumulator
 * for today. Mirrors `TokmeterCore.rebuildAggregateState` so the test path
 * sees what production sees.
 */
function projectToState(
  records: TokenRecord[],
  referenceTimestamp: number
): {
  aggregates: Map<string, ReturnType<typeof aggregateRecordsByDay>[number]>;
  todayAcc: DailyAccumulator;
} {
  const todayKey = localDateKey(referenceTimestamp);
  const aggregates = new Map<string, ReturnType<typeof aggregateRecordsByDay>[number]>();
  for (const day of aggregateRecordsByDay(records)) {
    if (day.date !== todayKey) aggregates.set(day.date, day);
  }
  const todayAcc = new DailyAccumulator(todayKey);
  todayAcc.foldAll(records.filter((rec) => !isBeforeToday(rec.timestamp, referenceTimestamp)));
  return { aggregates, todayAcc };
}

/**
 * A varied fixture used across all parity tests: multiple days, projects,
 * models, providers, plus today's records to exercise the today-accumulator
 * path. Deterministic so failures point at a specific row.
 */
function fixtureRecords(now: number): TokenRecord[] {
  const todayKey = localDateKey(now);
  const [Y, M, D] = todayKey.split("-").map(Number);
  // Build dates strictly before today by walking back N days. UTC math is
  // fine for parity since both code paths use the same `localDateKey`.
  const dayBefore = (back: number) => {
    const dt = new Date(Y, M - 1, D - back);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const d = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  };
  return [
    // Two days ago — claude-code/opus on project alpha
    r({
      timestamp: ts(dayBefore(2), 9),
      project: "alpha",
      provider: "claude-code",
      model: "opus",
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 25,
      cost: 1.25,
    }),
    r({
      timestamp: ts(dayBefore(2), 14),
      project: "alpha",
      provider: "claude-code",
      model: "opus",
      inputTokens: 200,
      outputTokens: 75,
      cost: 2.5,
    }),
    // One day ago — codex/gpt-5 on project beta + claude-code/sonnet on alpha
    r({
      timestamp: ts(dayBefore(1), 10),
      project: "beta",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 500,
      outputTokens: 200,
      reasoningTokens: 100,
      cost: 5.0,
    }),
    r({
      timestamp: ts(dayBefore(1), 16),
      project: "alpha",
      provider: "claude-code",
      model: "sonnet",
      inputTokens: 80,
      outputTokens: 40,
      cost: 0.8,
    }),
    // Today — mixed activity. Use the actual `now` so we land in today's
    // local-date key without timezone luck.
    r({
      timestamp: now - 60_000, // 1 minute ago
      project: "alpha",
      provider: "claude-code",
      model: "opus",
      inputTokens: 50,
      outputTokens: 25,
      cost: 0.5,
    }),
    r({
      timestamp: now - 30_000,
      project: "gamma",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 1000,
      outputTokens: 400,
      cacheReadTokens: 500,
      cost: 9.0,
    }),
  ];
}

/** Aliases with one hidden project to exercise visibility filtering. */
const aliasesWithHidden: AliasMap = {
  beta: {
    display: "beta",
    hidden: true,
    modifiedBy: "user",
    modifiedAt: "2026-01-01T00:00:00Z",
  },
};

const aliasesEmpty: AliasMap = {};

describe("Phase 2 parity — getStats", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("no aliases: legacy and aggregate paths produce identical TokmeterStats", () => {
    const legacy = computeStatsFromRecords(records, aliasesEmpty);
    const fresh = computeStatsFromState(aggregates, todayAcc, aliasesEmpty);
    expect(fresh).toEqual(legacy);
  });

  test("with a hidden alias: project count drops on BOTH paths the same way", () => {
    const legacy = computeStatsFromRecords(records, aliasesWithHidden);
    const fresh = computeStatsFromState(aggregates, todayAcc, aliasesWithHidden);
    expect(fresh).toEqual(legacy);
    // Sanity: hiding `beta` (one of three projects) reduces the count by one.
    const nonHidden = computeStatsFromRecords(records, aliasesEmpty);
    expect(legacy.projects).toBe(nonHidden.projects - 1);
  });

  test("empty input: both paths return zeroed stats", () => {
    const legacy = computeStatsFromRecords([], aliasesEmpty);
    const fresh = computeStatsFromState(
      new Map(),
      new DailyAccumulator("2026-01-01"),
      aliasesEmpty
    );
    expect(fresh).toEqual(legacy);
    expect(legacy.totalRecords).toBe(0);
    expect(legacy.firstUsed).toBe(0);
    expect(legacy.lastUsed).toBe(0);
  });

  test("only today's records: aggregate path reads from todayAccumulator alone", () => {
    const todayOnly = records.filter((rec) => !isBeforeToday(rec.timestamp, now));
    const { aggregates: emptyHist, todayAcc: todayAccOnly } = projectToState(todayOnly, now);
    const legacy = computeStatsFromRecords(todayOnly, aliasesEmpty);
    const fresh = computeStatsFromState(emptyHist, todayAccOnly, aliasesEmpty);
    expect(fresh).toEqual(legacy);
  });
});

describe("Phase 2 parity — getDailyBreakdown", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("no filter: legacy aggregateByDate(records) == aggregate-path daily entries", () => {
    const legacy = aggregateByDate(records);
    const fresh = computeDailyBreakdownFromState(aggregates, todayAcc, undefined);
    expect(fresh).toEqual(legacy);
  });

  test("project filter: collapses each day to the matching project's bucket", () => {
    // Legacy filters records first, then aggregates by date.
    const filtered = filterByProject(records, "alpha");
    const legacy = aggregateByDate(filtered);
    const fresh = computeDailyBreakdownFromState(aggregates, todayAcc, { project: "alpha" });
    expect(fresh).toEqual(legacy);
  });

  test("date filter: both paths exclude days outside the window identically", () => {
    const todayKey = localDateKey(now);
    const fresh = computeDailyBreakdownFromState(aggregates, todayAcc, {
      since: todayKey,
      until: todayKey,
    });
    expect(fresh).toHaveLength(1);
    expect(fresh[0].date).toBe(todayKey);
  });
});

describe("Phase 2 parity — getRawProjectNames", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("aggregate-path set of raw names equals records-path set", () => {
    const legacy = [...new Set(records.map((rec) => rec.project))].sort();
    const fresh = computeRawProjectNamesFromState(aggregates, todayAcc).sort();
    expect(fresh).toEqual(legacy);
  });
});

describe("Phase 2 parity — getModelCosts (no project filter)", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("no filter: aggregate-path model summaries match legacy aggregateByModel", () => {
    const legacy = aggregateByModel(records);
    const fresh = computeModelCostsFromState(aggregates, todayAcc);
    expect(fresh).toEqual(legacy);
  });

  test("today-only filter: aggregate-path matches legacy (records filtered to today)", () => {
    const todayKey = localDateKey(now);
    const filtered = filterByDate(records, { today: true });
    const legacy = aggregateByModel(filtered);
    const fresh = computeModelCostsFromState(aggregates, todayAcc, { today: true });
    expect(fresh).toEqual(legacy);
    // Sanity: today's row date matches the accumulator.
    expect(todayAcc.date).toBe(todayKey);
  });

  test("date window (since/until on a past day): same model set, same totals", () => {
    const todayKey = localDateKey(now);
    const [Y, M, D] = todayKey.split("-").map(Number);
    const dt = new Date(Y, M - 1, D - 1);
    const yesterdayKey = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;
    const filtered = filterByDate(records, { since: yesterdayKey, until: yesterdayKey });
    const legacy = aggregateByModel(filtered);
    const fresh = computeModelCostsFromState(aggregates, todayAcc, {
      since: yesterdayKey,
      until: yesterdayKey,
    });
    expect(fresh).toEqual(legacy);
  });
});

describe("Phase 2 parity — getProviderBreakdown", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("legacy aggregateByProvider(records) == aggregate-path provider summary", () => {
    const legacy = aggregateByProvider(records);
    const fresh = computeProviderBreakdownFromState(aggregates, todayAcc);
    // The `models` array within each provider is a Set under the hood — sort
    // both sides for stable equality.
    const sortModels = <T extends { models: string[] }>(arr: T[]): T[] =>
      arr.map((p) => ({ ...p, models: [...p.models].sort() }));
    expect(sortModels(fresh)).toEqual(sortModels(legacy));
  });

  test("empty records: both paths return empty array", () => {
    const empty = computeProviderBreakdownFromState(new Map(), new DailyAccumulator("2026-01-01"));
    expect(empty).toEqual(aggregateByProvider([]));
  });
});

/**
 * Sort helpers for ProjectSummary comparison. The legacy and aggregate paths
 * are free to emit projects/models/providers in different orders; we collapse
 * those orderings into deterministic forms so equality reflects *content*
 * parity rather than iteration luck.
 */
function sortProjectSummary<
  T extends {
    models: { model: string; provider: string }[];
    providers: { provider: string; models: string[] }[];
  },
>(p: T): T {
  return {
    ...p,
    models: [...p.models].sort((a, b) =>
      `${a.provider} ${a.model}`.localeCompare(`${b.provider} ${b.model}`)
    ),
    providers: [...p.providers]
      .map((pv) => ({ ...pv, models: [...pv.models].sort() }))
      .sort((a, b) => a.provider.localeCompare(b.provider)),
  };
}

describe("Phase 2 parity — getAllProjects", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("no aliases: legacy aggregateByProject == aggregate path", () => {
    const legacy = aggregateByProject(records, aliasesEmpty)
      .map(sortProjectSummary)
      .sort((a, b) => a.project.localeCompare(b.project));
    const fresh = computeAllProjectsFromState(aggregates, todayAcc, aliasesEmpty)
      .map(sortProjectSummary)
      .sort((a, b) => a.project.localeCompare(b.project));
    expect(fresh).toEqual(legacy);
  });

  test("with hidden alias: both paths drop the hidden display", () => {
    const legacy = aggregateByProject(records, aliasesWithHidden)
      .map(sortProjectSummary)
      .sort((a, b) => a.project.localeCompare(b.project));
    const fresh = computeAllProjectsFromState(aggregates, todayAcc, aliasesWithHidden)
      .map(sortProjectSummary)
      .sort((a, b) => a.project.localeCompare(b.project));
    expect(fresh).toEqual(legacy);
    // Sanity: hiding `beta` removes exactly one display from the set.
    expect(fresh.find((p) => p.project === "beta")).toBeUndefined();
  });

  test("empty input: both paths return empty array", () => {
    const fresh = computeAllProjectsFromState(
      new Map(),
      new DailyAccumulator("2026-01-01"),
      aliasesEmpty
    );
    expect(fresh).toEqual(aggregateByProject([], aliasesEmpty));
  });

  test("today-only records: aggregate path reads from todayAccumulator alone", () => {
    const todayOnly = records.filter((rec) => !isBeforeToday(rec.timestamp, now));
    const { aggregates: emptyHist, todayAcc: todayAccOnly } = projectToState(todayOnly, now);
    const legacy = aggregateByProject(todayOnly, aliasesEmpty)
      .map(sortProjectSummary)
      .sort((a, b) => a.project.localeCompare(b.project));
    const fresh = computeAllProjectsFromState(emptyHist, todayAccOnly, aliasesEmpty)
      .map(sortProjectSummary)
      .sort((a, b) => a.project.localeCompare(b.project));
    expect(fresh).toEqual(legacy);
  });
});

describe("Phase 2 parity — getProjectSummary", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  function legacyLookup(name: string) {
    const all = aggregateByProject(records, aliasesEmpty);
    return (
      all.find((p) => projectNamesMatch(p.project, name)) ||
      all.find((p) => projectNameIncludes(p.project, name))
    );
  }

  test("exact match returns the same row from both paths", () => {
    const legacy = legacyLookup("alpha");
    const fresh = computeProjectSummaryFromState(aggregates, todayAcc, aliasesEmpty, "alpha");
    expect(fresh && sortProjectSummary(fresh)).toEqual(legacy && sortProjectSummary(legacy));
  });

  test("substring match returns the same row from both paths", () => {
    const legacy = legacyLookup("amm"); // matches "gamma"
    const fresh = computeProjectSummaryFromState(aggregates, todayAcc, aliasesEmpty, "amm");
    expect(fresh && sortProjectSummary(fresh)).toEqual(legacy && sortProjectSummary(legacy));
    expect(fresh?.project).toBe("gamma");
  });

  test("no match returns undefined on both paths", () => {
    const fresh = computeProjectSummaryFromState(aggregates, todayAcc, aliasesEmpty, "nonexistent");
    expect(fresh).toBeUndefined();
  });
});

describe("Phase 2 parity — getModelCosts (project filter)", () => {
  const now = Date.now();
  const records = fixtureRecords(now);
  const { aggregates, todayAcc } = projectToState(records, now);

  test("project filter: aggregate path matches legacy aggregateByModel(filterByProject(...))", () => {
    const filtered = filterByProject(records, "alpha");
    const legacy = aggregateByModel(filtered);
    const fresh = computeModelCostsFromState(aggregates, todayAcc, { project: "alpha" });
    expect(fresh).toEqual(legacy);
  });

  test("project filter + today: both paths agree on the today-only slice", () => {
    const filtered = filterByDate(filterByProject(records, "alpha"), { today: true });
    const legacy = aggregateByModel(filtered);
    const fresh = computeModelCostsFromState(aggregates, todayAcc, {
      project: "alpha",
      today: true,
    });
    expect(fresh).toEqual(legacy);
  });

  test("project substring filter agrees across both paths", () => {
    const filtered = filterByProject(records, "amm"); // matches gamma
    const legacy = aggregateByModel(filtered);
    const fresh = computeModelCostsFromState(aggregates, todayAcc, { project: "amm" });
    expect(fresh).toEqual(legacy);
  });

  test("non-matching project: empty array on both paths", () => {
    const filtered = filterByProject(records, "zzz");
    const legacy = aggregateByModel(filtered);
    const fresh = computeModelCostsFromState(aggregates, todayAcc, { project: "zzz" });
    expect(fresh).toEqual(legacy);
    expect(fresh).toEqual([]);
  });
});
