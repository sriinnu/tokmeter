import { describe, expect, test } from "vitest";
import { aggregateRecordsByDay, longestConsecutiveDayStreak, sumAggregates } from "./aggregates.js";
import type { TokenRecord } from "./types.js";

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

// Construct timestamps in a fixed timezone-agnostic way: midday UTC on a date
// gives the same local-date-key across any sane timezone the test runs in.
function ts(date: string): number {
  return Date.parse(`${date}T12:00:00Z`);
}

describe("aggregateRecordsByDay — single pass roll-up", () => {
  test("empty input → empty output", () => {
    expect(aggregateRecordsByDay([])).toEqual([]);
  });

  test("buckets every record's fields at every level (day / model / project / provider)", () => {
    const days = aggregateRecordsByDay([
      r({
        timestamp: ts("2026-05-20"),
        project: "p1",
        provider: "claude-code",
        model: "opus",
        inputTokens: 100,
        outputTokens: 50,
        cost: 1.5,
      }),
      r({
        timestamp: ts("2026-05-20"),
        project: "p1",
        provider: "claude-code",
        model: "opus",
        inputTokens: 200,
        outputTokens: 75,
        cost: 3.0,
      }),
      r({
        timestamp: ts("2026-05-20"),
        project: "p2",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 10,
        outputTokens: 5,
        cost: 0.25,
      }),
    ]);

    expect(days).toHaveLength(1);
    const d = days[0];
    expect(d.date).toBe("2026-05-20");
    // Day-level sums equal sum-of-records.
    expect(d.cost).toBe(4.75);
    expect(d.inputTokens).toBe(310);
    expect(d.outputTokens).toBe(130);
    expect(d.recordCount).toBe(3);
    expect(d.totalTokens).toBe(310 + 130);

    // Per-model: opus has 2 records, gpt-5 has 1.
    expect(d.models.opus.recordCount).toBe(2);
    expect(d.models.opus.cost).toBeCloseTo(4.5, 10);
    expect(d.models.opus.providers).toEqual(["claude-code"]);
    expect(d.models["gpt-5"].recordCount).toBe(1);
    expect(d.models["gpt-5"].cost).toBe(0.25);
    expect(d.models["gpt-5"].providers).toEqual(["codex"]);

    // Per-project: p1 has 2 records, p2 has 1.
    expect(d.projects.p1.recordCount).toBe(2);
    expect(d.projects.p1.cost).toBeCloseTo(4.5, 10);
    expect(d.projects.p1.models).toEqual(["opus"]);
    expect(d.projects.p2.recordCount).toBe(1);
    expect(d.projects.p2.models).toEqual(["gpt-5"]);

    // Per-provider: claude-code 2, codex 1.
    expect(d.providers["claude-code"].recordCount).toBe(2);
    expect(d.providers.codex.recordCount).toBe(1);
  });

  test("splits across days; sorts by date ascending", () => {
    const days = aggregateRecordsByDay([
      r({ timestamp: ts("2026-05-22"), cost: 3 }),
      r({ timestamp: ts("2026-05-20"), cost: 1 }),
      r({ timestamp: ts("2026-05-21"), cost: 2 }),
    ]);
    expect(days.map((d) => d.date)).toEqual(["2026-05-20", "2026-05-21", "2026-05-22"]);
    expect(days.map((d) => d.cost)).toEqual([1, 2, 3]);
  });

  test("firstUsed / lastUsed are the day's earliest and latest record timestamps", () => {
    const day = aggregateRecordsByDay([
      r({ timestamp: Date.parse("2026-05-20T08:00:00Z"), cost: 1 }),
      r({ timestamp: Date.parse("2026-05-20T18:00:00Z"), cost: 1 }),
      r({ timestamp: Date.parse("2026-05-20T12:00:00Z"), cost: 1 }),
    ])[0];
    expect(day.firstUsed).toBe(Date.parse("2026-05-20T08:00:00Z"));
    expect(day.lastUsed).toBe(Date.parse("2026-05-20T18:00:00Z"));
  });

  test("a single model used under two providers tracks both", () => {
    const day = aggregateRecordsByDay([
      r({ timestamp: ts("2026-05-20"), model: "gpt-5", provider: "codex" }),
      r({ timestamp: ts("2026-05-20"), model: "gpt-5", provider: "opencode" }),
    ])[0];
    expect(day.models["gpt-5"].providers.sort()).toEqual(["codex", "opencode"]);
  });
});

describe("sumAggregates — lifetime rollup", () => {
  test("sums across days and collects distinct model/project/provider sets", () => {
    const days = aggregateRecordsByDay([
      r({
        timestamp: ts("2026-05-20"),
        project: "p1",
        provider: "claude-code",
        model: "opus",
        inputTokens: 100,
        outputTokens: 50,
        cost: 1.5,
      }),
      r({
        timestamp: ts("2026-05-21"),
        project: "p2",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 200,
        outputTokens: 75,
        cost: 3.0,
      }),
    ]);
    const total = sumAggregates(days);
    expect(total.cost).toBe(4.5);
    expect(total.recordCount).toBe(2);
    expect(total.totalTokens).toBe(100 + 50 + 200 + 75);
    expect(total.activeDays).toBe(2);
    expect([...total.models].sort()).toEqual(["gpt-5", "opus"]);
    expect([...total.projects].sort()).toEqual(["p1", "p2"]);
    expect([...total.providers].sort()).toEqual(["claude-code", "codex"]);
  });

  test("empty input → zeros and empty sets", () => {
    const total = sumAggregates([]);
    expect(total.cost).toBe(0);
    expect(total.activeDays).toBe(0);
    expect(total.firstUsed).toBe(0);
    expect(total.lastUsed).toBe(0);
    expect(total.models.size).toBe(0);
  });
});

describe("longestConsecutiveDayStreak", () => {
  test("zero days → 0", () => {
    expect(longestConsecutiveDayStreak([])).toBe(0);
  });

  test("single day → 1", () => {
    const d = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    expect(longestConsecutiveDayStreak(d)).toBe(1);
  });

  test("consecutive days run end-to-end", () => {
    const d = aggregateRecordsByDay([
      r({ timestamp: ts("2026-05-20"), cost: 1 }),
      r({ timestamp: ts("2026-05-21"), cost: 1 }),
      r({ timestamp: ts("2026-05-22"), cost: 1 }),
    ]);
    expect(longestConsecutiveDayStreak(d)).toBe(3);
  });

  test("a gap resets the streak; the longest run wins", () => {
    const d = aggregateRecordsByDay([
      r({ timestamp: ts("2026-05-01"), cost: 1 }),
      r({ timestamp: ts("2026-05-02"), cost: 1 }),
      r({ timestamp: ts("2026-05-03"), cost: 1 }),
      r({ timestamp: ts("2026-05-10"), cost: 1 }), // gap
      r({ timestamp: ts("2026-05-11"), cost: 1 }),
    ]);
    expect(longestConsecutiveDayStreak(d)).toBe(3);
  });
});

describe("JSON round-trip — aggregates serialize losslessly", () => {
  test("stringify then parse yields equal aggregates (no Map/Set leak)", () => {
    const days = aggregateRecordsByDay([
      r({
        timestamp: ts("2026-05-20"),
        project: "demo",
        provider: "claude-code",
        model: "opus",
        inputTokens: 100,
        cost: 1,
      }),
    ]);
    const restored = JSON.parse(JSON.stringify(days));
    expect(restored).toEqual(days);
  });
});
