// Frozen-cost invariant: a new model or a price change TODAY must never alter
// yesterday's or any earlier total. This locks the gate that enforces it —
// today-scope scans only (re)price records dated today; everything before today
// is frozen. (Sealed day files are also immutable on disk; see the
// round-trip/snapshot coverage in aggregates-store.test.ts + relay-loader.test.ts.)

import { describe, expect, test } from "vitest";
import { localDateKey } from "./date-utils.js";
import { todayPricingStale } from "./pricing.js";
import { selectRecordsToPrice } from "./scan-pipeline.js";
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

describe("today reprice trigger — todayPricingStale", () => {
  const priced = { registryMtime: 1000, overridesMtime: 0 };

  test("nothing changed → today keeps its prices", () => {
    expect(todayPricingStale({ registryMtime: 1000, overridesMtime: 0 }, priced)).toBe(false);
  });

  test("kosha registry refreshed → reprice today", () => {
    expect(todayPricingStale({ registryMtime: 2000, overridesMtime: 0 }, priced)).toBe(true);
  });

  test("pricing-overrides file added or edited → reprice today", () => {
    expect(todayPricingStale({ registryMtime: 1000, overridesMtime: 5000 }, priced)).toBe(true);
    expect(
      todayPricingStale(
        { registryMtime: 1000, overridesMtime: 6000 },
        { registryMtime: 1000, overridesMtime: 5000 }
      )
    ).toBe(true);
  });

  test("pricing-overrides file removed → reprice today", () => {
    expect(
      todayPricingStale(
        { registryMtime: 1000, overridesMtime: 0 },
        { registryMtime: 1000, overridesMtime: 5000 }
      )
    ).toBe(true);
  });

  test("kosha unavailable (mtime 0) alone never forces a reprice", () => {
    expect(todayPricingStale({ registryMtime: 0, overridesMtime: 0 }, priced)).toBe(false);
  });

  test("the trigger only reprices today — history stays frozen either way", () => {
    // The trigger decides WHETHER to reprice; selectRecordsToPrice decides WHAT.
    const all = [rec(REF - 2 * DAY, 1.5), rec(REF, 0)];
    expect(todayPricingStale({ registryMtime: 1000, overridesMtime: 7000 }, priced)).toBe(true);
    expect(selectRecordsToPrice(all, "today", REF)).toEqual([all[1]]);
  });
});
