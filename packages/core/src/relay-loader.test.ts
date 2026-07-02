// relay-loader orchestration tests — the cold-start / gap-fill decision logic.
//
// Parsers resolve their corpus from ctx.homeDir (expandHome("~/…", homeDir)),
// so a temp homeDir fully isolates these from the real ~/.claude. skipPricing
// keeps the pricing service out of the picture (stubbed). We seed the relay by
// writing day files directly, then assert refreshFromRelay's branch behavior.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { aggregateRecordsByDay } from "./aggregates.js";
import { listDaysOnDisk, writeDayFile } from "./aggregates-store.js";
import { localDateKey, yesterdayDateKey } from "./date-utils.js";
import { refreshFromRelay } from "./relay-loader.js";
import type { ScanContext } from "./scan-pipeline.js";
import type { PricingService } from "./pricing.js";
import type { TokenRecord } from "./types.js";

// skipPricing:true means none of these are called — a stub satisfies the type.
const stubPricing = {
  init: async () => {},
  calculateCost: async () => 0,
  getRegistryMtime: () => 0,
} as unknown as PricingService;

const ctxFor = (homeDir: string): ScanContext => ({
  homeDir,
  pricing: stubPricing,
  skipPricing: true,
});

const r = (ts: number, cost: number): TokenRecord =>
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

// Local noon avoids DST/midnight edges when deriving day keys.
const REF = Date.parse("2026-06-15T12:00:00");
const DAY = 86_400_000;

function seedDay(homeDir: string, ts: number, cost: number): string {
  const [day] = aggregateRecordsByDay([r(ts, cost)]);
  writeDayFile(homeDir, day);
  return day.date;
}

describe("refreshFromRelay — cold-start / gap-fill orchestration", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-relay-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("empty relay + no corpus → full rebuild yields nothing (historySource none)", async () => {
    const warnings: never[] = [];
    const state = await refreshFromRelay(ctxFor(home), REF, warnings, false);
    expect(state.aggregates.size).toBe(0);
    expect(state.historySource).toBe("none");
  });

  test("relay current through yesterday → loads snapshot, no rescan/gap-fill", async () => {
    const yKey = seedDay(home, REF - DAY, 1.25); // yesterday
    expect(yKey).toBe(yesterdayDateKey(REF));

    const warnings: never[] = [];
    const state = await refreshFromRelay(ctxFor(home), REF, warnings, false);
    expect(state.historySource).toBe("snapshot");
    expect(state.aggregates.has(yKey)).toBe(true);
    expect(state.aggregates.get(yKey)?.cost).toBeCloseTo(1.25, 10);
  });

  test("relay behind yesterday with empty corpus → gap path runs, existing day preserved, no crash", async () => {
    const oldKey = seedDay(home, REF - 5 * DAY, 2.0); // 5 days before REF
    expect(oldKey < yesterdayDateKey(REF)).toBe(true);

    const warnings: never[] = [];
    const state = await refreshFromRelay(ctxFor(home), REF, warnings, false);
    // Gap scan found no records (empty corpus), so nothing new is sealed, but
    // the already-on-disk day must survive and today must never be sealed.
    expect(state.aggregates.has(oldKey)).toBe(true);
    expect(state.aggregates.has(localDateKey(REF))).toBe(false);
    expect(state.historySource).toBe("extended");
  });

  test("forceRebuild ignores the on-disk relay and rebuilds from the (empty) corpus", async () => {
    seedDay(home, REF - DAY, 9.99);
    const warnings: never[] = [];
    const state = await refreshFromRelay(ctxFor(home), REF, warnings, true);
    // A forced rebuild derives purely from the corpus (empty here) — the seeded
    // day is not carried over.
    expect(state.aggregates.size).toBe(0);
    expect(listDaysOnDisk(home)).not.toContain(localDateKey(REF));
  });
});
