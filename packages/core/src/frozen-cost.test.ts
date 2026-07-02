// Frozen-cost invariant: a new model or a price change TODAY must never alter
// yesterday's or any earlier total. This locks the gate that enforces it —
// today-scope scans only (re)price records dated today; everything before today
// is frozen. (Sealed day files are also immutable on disk; see the
// round-trip/snapshot coverage in aggregates-store.test.ts + relay-loader.test.ts.)

import { describe, expect, test } from "vitest";
import { selectRecordsToPrice } from "./scan-pipeline.js";
import { localDateKey } from "./date-utils.js";
import type { TokenRecord } from "./types.js";

const DAY = 86_400_000;
const REF = Date.parse("2026-06-15T12:00:00"); // local noon, safe from edges

const rec = (ts: number, cost: number): TokenRecord =>
  ({
    timestamp: ts,
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    project: "demo",
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost,
  }) as TokenRecord;

describe("frozen-cost gate — selectRecordsToPrice", () => {
  const yesterday = rec(REF - DAY, 0); // e.g. a $0 tail (model wasn't priced then)
  const earlier = rec(REF - 5 * DAY, 0);
  const today = rec(REF, 0);
  const all = [earlier, yesterday, today];

  test("today-scope prices ONLY today's records — history stays frozen", () => {
    const picked = selectRecordsToPrice(all, "today", REF);
    expect(picked).toHaveLength(1);
    expect(localDateKey(picked[0].timestamp)).toBe(localDateKey(REF));
    // The before-today records are excluded → a price change today can't touch them.
    expect(picked).not.toContain(yesterday);
    expect(picked).not.toContain(earlier);
  });

  test("history-scope prices everything (fresh days being committed)", () => {
    const picked = selectRecordsToPrice(all, "history", REF);
    expect(picked).toHaveLength(3);
  });

  test("today-scope with no today records prices nothing", () => {
    const picked = selectRecordsToPrice([earlier, yesterday], "today", REF);
    expect(picked).toHaveLength(0);
  });

  test("a yesterday tail in a today-active file is never selected for repricing", () => {
    // The exact scenario the gate exists for: a still-active JSONL whose tail is
    // yesterday-dated. Only the today line is priced; the yesterday line is frozen.
    const picked = selectRecordsToPrice([rec(REF - DAY + 1000, 0), today], "today", REF);
    expect(picked).toEqual([today]);
  });
});
