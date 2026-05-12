import { describe, expect, test } from "vitest";
import { computeStatbarSignals } from "./signals.js";
import type { TokenRecord } from "./types.js";

/** Build a record with sensible defaults — keeps tests focused on the field
 *  under test instead of restating every zero. */
function r(overrides: Partial<TokenRecord> & Pick<TokenRecord, "timestamp">): TokenRecord {
  return {
    timestamp: overrides.timestamp,
    project: overrides.project ?? "demo",
    provider: overrides.provider ?? "claude-code",
    model: overrides.model ?? "claude-sonnet-4-5",
    inputTokens: overrides.inputTokens ?? 0,
    outputTokens: overrides.outputTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 0,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 0,
    reasoningTokens: overrides.reasoningTokens ?? 0,
    cost: overrides.cost ?? 0,
    kind: overrides.kind,
  };
}

describe("computeStatbarSignals", () => {
  // Pin to a deterministic moment so date math + windows are predictable.
  // 2026-04-15 14:30 local time.
  const now = new Date(2026, 3, 15, 14, 30, 0).getTime();
  const HOUR = 3600 * 1000;
  const MIN = 60 * 1000;

  test("returns zeros and a hidden ribbon when no records exist", () => {
    const s = computeStatbarSignals([], now);
    expect(s.burnRate.costPerHour).toBe(0);
    expect(s.burnRate.recordsInWindow).toBe(0);
    expect(s.cacheHitToday.rate).toBe(0);
    expect(s.pace.multiple).toBeNull();
    expect(s.compactionToday.cost).toBe(0);
    expect(s.liveSession).toBeNull();
  });

  test("burn rate sums cost in the last 60 minutes", () => {
    const records = [
      r({ timestamp: now - 30 * MIN, cost: 1.5 }), // inside window
      r({ timestamp: now - 10 * MIN, cost: 0.75 }), // inside window
      r({ timestamp: now - 90 * MIN, cost: 99 }), // outside window
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.burnRate.recordsInWindow).toBe(2);
    expect(s.burnRate.costPerHour).toBeCloseTo(2.25);
  });

  test("cache hit rate uses today's input + cache read", () => {
    const records = [
      r({ timestamp: now - 1 * HOUR, inputTokens: 100, cacheReadTokens: 900 }),
      r({ timestamp: now - 2 * HOUR, inputTokens: 50, cacheReadTokens: 50 }),
      // Yesterday's record should NOT count toward today's cache hit.
      r({ timestamp: now - 30 * HOUR, inputTokens: 0, cacheReadTokens: 10_000 }),
    ];
    const s = computeStatbarSignals(records, now);
    // input=150, cacheRead=950 → 950/1100 ≈ 0.863
    expect(s.cacheHitToday.rate).toBeCloseTo(950 / 1100, 5);
    expect(s.cacheHitToday.cacheReadTokens).toBe(950);
    expect(s.cacheHitToday.inputTokens).toBe(150);
  });

  test("pace multiple compares today vs typical cost by this hour", () => {
    // Build 3 past days where by 14:30 the user had spent $4 each.
    // Today they've spent $6 by 14:30 → pace should be 1.5×.
    const records: TokenRecord[] = [];
    for (let dayOffset = 1; dayOffset <= 3; dayOffset++) {
      const dayBase = new Date(2026, 3, 15 - dayOffset, 10, 0, 0).getTime();
      records.push(r({ timestamp: dayBase, cost: 4 }));
    }
    // Today's spend before `now`
    records.push(r({ timestamp: new Date(2026, 3, 15, 9, 0, 0).getTime(), cost: 6 }));

    const s = computeStatbarSignals(records, now);
    expect(s.pace.typicalCostByNow).toBeCloseTo(4);
    expect(s.pace.actualCostByNow).toBeCloseTo(6);
    expect(s.pace.multiple).toBeCloseTo(1.5, 2);
    expect(s.pace.daysOfHistory).toBe(3);
  });

  test("compaction share is the slice of today's spend tagged kind:compaction", () => {
    const records = [
      r({ timestamp: now - 1 * HOUR, cost: 4, kind: "normal" }),
      r({ timestamp: now - 30 * MIN, cost: 1, kind: "compaction" }),
      r({ timestamp: now - 15 * MIN, cost: 0.5, kind: "compaction" }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.compactionToday.cost).toBeCloseTo(1.5);
    expect(s.compactionToday.events).toBe(2);
    // 1.5 / 5.5 ≈ 0.273
    expect(s.compactionToday.share).toBeCloseTo(1.5 / 5.5, 5);
  });

  test("live session pill activates when the latest record is fresh", () => {
    const records = [
      r({ timestamp: now - 2 * MIN, project: "tokmeter", model: "claude-sonnet-4-5", cost: 0.04 }),
      r({ timestamp: now - 1 * HOUR, project: "old", cost: 1 }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.liveSession).not.toBeNull();
    expect(s.liveSession?.project).toBe("tokmeter");
    expect(s.liveSession?.ageSeconds).toBeLessThanOrEqual(120);
  });

  test("live session pill goes null when the latest record is stale", () => {
    const records = [r({ timestamp: now - 30 * MIN, project: "stale", cost: 1 })];
    const s = computeStatbarSignals(records, now);
    expect(s.liveSession).toBeNull();
  });
});
