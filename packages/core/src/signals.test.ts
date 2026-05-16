import { describe, expect, test } from "vitest";
import { computeStatbarSignals } from "./signals.js";
import type { TokenRecord } from "./types.js";

/** Build a record with sensible defaults — keeps tests focused on the field
 *  under test instead of restating every zero. */
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

  test("subagent share is the slice of today's spend tagged isSubagent", () => {
    const records = [
      r({ timestamp: now - 1 * HOUR, cost: 3, isSubagent: undefined }),
      r({ timestamp: now - 45 * MIN, cost: 1, isSubagent: true }),
      r({ timestamp: now - 15 * MIN, cost: 0.5, isSubagent: true }),
      // Yesterday — must not contribute
      r({ timestamp: now - 30 * HOUR, cost: 99, isSubagent: true }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.subagentToday.cost).toBeCloseTo(1.5);
    expect(s.subagentToday.records).toBe(2);
    // 1.5 / 4.5
    expect(s.subagentToday.share).toBeCloseTo(1.5 / 4.5, 5);
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

  test("reasoning share is reasoning tokens over today's total output tokens", () => {
    const records = [
      // 400 output, 240 of it reasoning
      r({ timestamp: now - 1 * HOUR, outputTokens: 400, reasoningTokens: 240 }),
      // 200 output, 60 reasoning
      r({ timestamp: now - 30 * MIN, outputTokens: 200, reasoningTokens: 60 }),
      // Output-only turn, no reasoning — denominator climbs, numerator doesn't
      r({ timestamp: now - 10 * MIN, outputTokens: 100, reasoningTokens: 0 }),
      // Yesterday — must not contribute
      r({ timestamp: now - 30 * HOUR, outputTokens: 5000, reasoningTokens: 5000 }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.reasoningToday.tokens).toBe(300);
    expect(s.reasoningToday.outputTokens).toBe(700);
    expect(s.reasoningToday.share).toBeCloseTo(300 / 700, 5);
    // Only the two records with reasoningTokens > 0 count toward the record tally.
    expect(s.reasoningToday.records).toBe(2);
  });

  test("tool-call breakdown splits parallel-tool cost evenly across tools", () => {
    const records = [
      // 4 tools in one turn at $1 → $0.25 per tool
      r({
        timestamp: now - 1 * HOUR,
        cost: 1,
        toolCalls: ["Bash", "Read", "Edit", "Bash"],
      }),
      // Single Bash turn at $0.5
      r({ timestamp: now - 30 * MIN, cost: 0.5, toolCalls: ["Bash"] }),
      // Text-only turn — must not contribute
      r({ timestamp: now - 10 * MIN, cost: 2.0 }),
      // Yesterday — must not contribute
      r({ timestamp: now - 30 * HOUR, cost: 99, toolCalls: ["Edit"] }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.toolCallsToday.totalCost).toBeCloseTo(1.5);
    expect(s.toolCallsToday.callCount).toBe(5);
    expect(s.toolCallsToday.turnsWithTools).toBe(2);
    // Bash: $0.25 + $0.25 (two in parallel turn) + $0.5 = $1.0
    // Read: $0.25; Edit: $0.25
    const byTool = Object.fromEntries(s.toolCallsToday.byTool.map((t) => [t.tool, t]));
    expect(byTool.Bash.cost).toBeCloseTo(1.0);
    expect(byTool.Bash.calls).toBe(3);
    expect(byTool.Read.cost).toBeCloseTo(0.25);
    expect(byTool.Edit.cost).toBeCloseTo(0.25);
    // Sorted descending: Bash first
    expect(s.toolCallsToday.byTool[0].tool).toBe("Bash");
  });

  test("tool-call breakdown is empty when no tools fired today", () => {
    const records = [r({ timestamp: now - 1 * HOUR, cost: 5 })];
    const s = computeStatbarSignals(records, now);
    expect(s.toolCallsToday.byTool).toHaveLength(0);
    expect(s.toolCallsToday.totalCost).toBe(0);
    expect(s.toolCallsToday.callCount).toBe(0);
    expect(s.toolCallsToday.turnsWithTools).toBe(0);
  });

  test("billing window opens on first Claude record and tracks cost across the 5h block", () => {
    const records = [
      // First Claude record starts block 1. Block runs 11:00 → 16:00.
      r({
        timestamp: new Date(2026, 3, 15, 11, 0, 0).getTime(),
        provider: "claude-code",
        cost: 0.5,
        inputTokens: 100,
      }),
      r({
        timestamp: new Date(2026, 3, 15, 13, 0, 0).getTime(),
        provider: "claude-code",
        cost: 1.2,
        outputTokens: 500,
      }),
      // Different provider — must not contribute
      r({ timestamp: new Date(2026, 3, 15, 14, 0, 0).getTime(), provider: "codex", cost: 99 }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).not.toBeNull();
    expect(s.billingWindow?.blockNumber).toBe(1);
    expect(s.billingWindow?.cost).toBeCloseTo(1.7);
    expect(s.billingWindow?.records).toBe(2);
    // Block end = 16:00, now = 14:30 → 1h30m remaining = 5400s
    expect(s.billingWindow?.remainingSec).toBe(5400);
    // 3.5h of 5h elapsed = 70%
    expect(s.billingWindow?.elapsedPct).toBeCloseTo(70, 1);
  });

  test("billing window blockNumber counts today's blocks, not lifetime", () => {
    // Yesterday's block must not bump blockNumber — the field is scoped to
    // today's session count, which matches the "today's pulse" framing of
    // every other signal in the payload.
    const records = [
      // Yesterday — should NOT contribute to blockNumber.
      r({
        timestamp: new Date(2026, 3, 14, 8, 0, 0).getTime(),
        provider: "claude-code",
        cost: 99,
      }),
      // Today's first record — the only block from today's perspective.
      r({
        timestamp: new Date(2026, 3, 15, 13, 0, 0).getTime(),
        provider: "claude-code",
        cost: 2.0,
      }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).not.toBeNull();
    expect(s.billingWindow?.blockNumber).toBe(1);
    expect(s.billingWindow?.cost).toBeCloseTo(2.0);
  });

  test("billing window counts multiple blocks within the same day", () => {
    // 04-15 has two blocks: 02:00 (long-finished) and 13:00 (current). Both
    // belong to today, so blockNumber=2 and the current block is the 13:00
    // one (cost only from records ≥ 13:00).
    const records = [
      // Block 1 today — 02:00, abandoned by 14:30 (now)
      r({
        timestamp: new Date(2026, 3, 15, 2, 0, 0).getTime(),
        provider: "claude-code",
        cost: 5,
      }),
      // Block 2 today — current
      r({
        timestamp: new Date(2026, 3, 15, 13, 0, 0).getTime(),
        provider: "claude-code",
        cost: 1.0,
      }),
      r({
        timestamp: new Date(2026, 3, 15, 14, 0, 0).getTime(),
        provider: "claude-code",
        cost: 1.5,
      }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).not.toBeNull();
    expect(s.billingWindow?.blockNumber).toBe(2);
    // Current-block cost only — the 02:00 block is excluded
    expect(s.billingWindow?.cost).toBeCloseTo(2.5);
  });

  test("billing window is null when the last block already expired", () => {
    const records = [
      r({
        timestamp: new Date(2026, 3, 14, 8, 0, 0).getTime(),
        provider: "claude-code",
        cost: 1,
      }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).toBeNull();
  });

  test("billing window does not fabricate a fresh block from an expired block's tail record", () => {
    // Regression: 5h lookback used to clip the previous block's opener, so
    // the surviving tail-end record became a phantom `blockStart` and the
    // UI claimed an active 5h block for hours after it had actually expired.
    // Fix: lookback extends 2× the billing window so the gap-walk can see
    // the original opener and identify the tail as continuation, not start.
    //
    // Scenario: block opens 9h before `now`, last record sits 5h before
    // `now` (still within block window since block ended at `now - 4h`).
    // At `now`, the block is ~1h past its 5h close — billing window must be
    // null, not "4h left".
    const blockOpen = new Date(2026, 3, 15, 5, 30, 0).getTime(); // 9h before now
    const blockTail = new Date(2026, 3, 15, 9, 30, 0).getTime(); // 5h before now
    const records = [
      r({ timestamp: blockOpen, provider: "claude-code", cost: 1 }),
      r({ timestamp: blockTail, provider: "claude-code", cost: 1 }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).toBeNull();
  });

  test("billing window detects recent Claude records even when array is unsorted", () => {
    // Regression: an earlier optimization walked backward with an early-break
    // on timestamp, assuming records were chronologically appended. Records
    // are actually interleaved across multiple session files, so the recent
    // Claude turn can sit AFTER a much-older non-Claude record in the array.
    // This test pins the fix — the walk must not bail early.
    const records = [
      // A recent Claude turn (should be detected).
      r({
        timestamp: new Date(2026, 3, 15, 14, 0, 0).getTime(),
        provider: "claude-code",
        cost: 2.0,
      }),
      // An old codex turn that USED to break the early-break optimization.
      r({
        timestamp: new Date(2026, 3, 10, 8, 0, 0).getTime(),
        provider: "codex",
        cost: 99,
      }),
    ];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).not.toBeNull();
    expect(s.billingWindow?.cost).toBeCloseTo(2.0);
  });

  test("billing window is null when no Claude records exist", () => {
    const records = [r({ timestamp: now - 1 * HOUR, provider: "codex", cost: 5 })];
    const s = computeStatbarSignals(records, now);
    expect(s.billingWindow).toBeNull();
  });

  test("reasoning share returns zero share when no output tokens today", () => {
    const records = [r({ timestamp: now - 30 * HOUR, outputTokens: 9999, reasoningTokens: 5000 })];
    const s = computeStatbarSignals(records, now);
    expect(s.reasoningToday.share).toBe(0);
    expect(s.reasoningToday.records).toBe(0);
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
