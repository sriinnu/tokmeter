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
import { listDaysOnDisk, writeDayFile } from "./aggregates-store.js";
import { aggregateRecordsByDay } from "./aggregates.js";
import { localDateKey, yesterdayDateKey } from "./date-utils.js";
import type { PricingService } from "./pricing.js";
import { refreshFromRelay } from "./relay-loader.js";
import type { ScanContext } from "./scan-pipeline.js";
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

describe("refreshFromRelay — bounded trailing-gap fill (no full rescan on a no-usage day)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-relay2-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("a no-usage day older than maxOnDisk does NOT trigger a rescan (fast snapshot path)", async () => {
    // day-5 used, day-4..day-1 no usage, day-0 (yesterday) used → onDisk has a
    // gap at day-4..day-2 that must be treated as covered, not re-scanned.
    seedDay(home, REF - 5 * DAY, 1.0);
    const yKey = seedDay(home, REF - DAY, 2.0); // yesterday is the newest
    expect(yKey).toBe(yesterdayDateKey(REF));

    const warnings: never[] = [];
    const state = await refreshFromRelay(ctxFor(home), REF, warnings, false);
    // maxOnDisk (yesterday) >= yesterday → snapshot short-circuit, no gap scan,
    // even though the middle days are absent (no-usage days, not holes).
    expect(state.historySource).toBe("snapshot");
    expect(state.aggregates.has(yKey)).toBe(true);
  });
});

// ─── Deep Rescan sealed-day guard (the 2026-07-12 history-shrink regression) ──
//
// rebuildRecentWindow re-derives the window from raw and used to overwrite
// sealed days unconditionally — a partial raw corpus (cleaned-up JSONL, a
// truncated read) permanently shrank sealed history. The guard: a sealed day
// is only replaced when the rebuild carries at least as much data, per
// provider. These tests drive the REAL codex parser against a fixture corpus
// in a temp home (codex keeps no record cache, so nothing leaks outside it).

import { mkdirSync, writeFileSync } from "node:fs";
import { type DailyAggregate, shouldKeepSealedDay } from "./aggregates.js";
import { rebuildRecentWindow } from "./relay-loader.js";
import type { ScanWarning } from "./types.js";

// Local-time ISO (no Z) so day keys are TZ-stable under both bun and vitest.
const codexEvents = (day: string, tokens: number[]): string =>
  [
    JSON.stringify({
      timestamp: `${day}T12:00:00`,
      type: "session_meta",
      payload: { cwd: "/tmp/demo" },
    }),
    JSON.stringify({
      timestamp: `${day}T12:00:01`,
      type: "turn_context",
      payload: { model: "gpt-5" },
    }),
    ...tokens.map((n, i) =>
      JSON.stringify({
        timestamp: `${day}T12:00:0${2 + i}`,
        type: "event_msg",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: n, output_tokens: 0 } },
        },
      })
    ),
  ].join("\n");

function writeCodexFixture(homeDir: string, day: string, tokens: number[]): void {
  const [y, m, d] = day.split("-");
  const dir = join(homeDir, ".codex/sessions", y, m, d);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `rollout-${day}-fixture.jsonl`), codexEvents(day, tokens));
}

const codexRecord = (ts: number, inputTokens: number): TokenRecord =>
  ({
    timestamp: ts,
    provider: "codex",
    model: "gpt-5",
    project: "demo",
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
  }) as TokenRecord;

describe("rebuildRecentWindow — sealed days never shrink without force", () => {
  let home: string;
  const DAY_KEY = "2026-06-13";
  const dayTs = Date.parse(`${DAY_KEY}T12:00:00`); // local noon
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-rescan-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function sealDay(tokenCounts: number[]): void {
    const [day] = aggregateRecordsByDay(tokenCounts.map((n, i) => codexRecord(dayTs + i, n)));
    writeDayFile(home, day);
  }

  test("partial raw (fewer tokens than sealed) → sealed day kept, warning pushed", async () => {
    sealDay([100, 200]); // sealed: 300 tokens
    writeCodexFixture(home, DAY_KEY, [100]); // raw now holds only 100
    const warnings: ScanWarning[] = [];
    const state = await rebuildRecentWindow(ctxFor(home), REF, warnings, 7);
    expect(state.aggregates.get(DAY_KEY)?.totalTokens).toBe(300);
    expect(warnings.some((w) => w.scope === "history" && w.message.includes(DAY_KEY))).toBe(true);
  });

  test("force=true replaces the sealed day even when the rebuild is smaller", async () => {
    sealDay([100, 200]);
    writeCodexFixture(home, DAY_KEY, [100]);
    const warnings: ScanWarning[] = [];
    const state = await rebuildRecentWindow(ctxFor(home), REF, warnings, 7, true);
    expect(state.aggregates.get(DAY_KEY)?.totalTokens).toBe(100);
  });

  test("richer raw (more tokens than sealed) → replaced without force", async () => {
    sealDay([100]); // sealed: 100 tokens
    writeCodexFixture(home, DAY_KEY, [100, 200]); // raw grew (e.g. parser fix found more)
    const warnings: ScanWarning[] = [];
    const state = await rebuildRecentWindow(ctxFor(home), REF, warnings, 7);
    expect(state.aggregates.get(DAY_KEY)?.totalTokens).toBe(300);
  });

  test("raw fully deleted → sealed day untouched (relay's core promise)", async () => {
    sealDay([100, 200]);
    const warnings: ScanWarning[] = [];
    const state = await rebuildRecentWindow(ctxFor(home), REF, warnings, 7);
    expect(state.aggregates.get(DAY_KEY)?.totalTokens).toBe(300);
  });
});

describe("shouldKeepSealedDay — per-provider no-shrink contract", () => {
  const dayFrom = (records: TokenRecord[]): DailyAggregate => aggregateRecordsByDay(records)[0];
  const ts = Date.parse("2026-06-13T12:00:00");

  test("day grows overall but one provider bucket shrinks → keep sealed", () => {
    const sealed = dayFrom([codexRecord(ts, 100), r(ts + 1, 0)]); // codex 100 + claude 120
    const rebuilt = dayFrom([codexRecord(ts, 50), r(ts + 1, 0), r(ts + 2, 0)]); // codex 50, claude 240
    expect(rebuilt.totalTokens).toBeGreaterThan(sealed.totalTokens);
    expect(shouldKeepSealedDay(sealed, rebuilt, { force: false })).toBe(true);
  });

  test("identical rebuild → replace (costByHour backfill must work)", () => {
    const sealed = dayFrom([codexRecord(ts, 100)]);
    const rebuilt = dayFrom([codexRecord(ts, 100)]);
    expect(shouldKeepSealedDay(sealed, rebuilt, { force: false })).toBe(false);
  });

  test("same tokens but lower cost (kosha offline during rescan) → keep sealed", () => {
    const sealed = dayFrom([{ ...codexRecord(ts, 100), cost: 2.5 } as TokenRecord]);
    const rebuilt = dayFrom([codexRecord(ts, 100)]); // cost 0 — pricing unavailable
    expect(rebuilt.totalTokens).toBe(sealed.totalTokens);
    expect(shouldKeepSealedDay(sealed, rebuilt, { force: false })).toBe(true);
    expect(shouldKeepSealedDay(sealed, rebuilt, { force: true })).toBe(false);
  });

  test("provider missing entirely from rebuild → keep sealed", () => {
    const sealed = dayFrom([codexRecord(ts, 100), r(ts + 1, 0)]);
    const rebuilt = dayFrom([r(ts + 1, 0)]); // codex vanished
    expect(shouldKeepSealedDay(sealed, rebuilt, { force: false })).toBe(true);
  });
});

describe("refreshFromRelay — gap fill never seals days before the gap", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-gapfix-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("pre-gap records admitted by the mtime watermark are not sealed as partial days", async () => {
    // Relay is current through 2026-06-10; the gap starts 06-11. A fresh-mtime
    // multi-day file also carries 06-09 records (a still-active old session).
    // 06-09 is an interior hole — sealing it from this one file's slice would
    // freeze a partial day forever.
    const seeded = seedDay(home, Date.parse("2026-06-10T12:00:00"), 1.0);
    expect(seeded).toBe("2026-06-10");
    writeCodexFixture(home, "2026-06-09", [500]);
    writeCodexFixture(home, "2026-06-14", [700]);
    const warnings: ScanWarning[] = [];
    const state = await refreshFromRelay(ctxFor(home), REF, warnings, false);
    expect(state.aggregates.has("2026-06-09")).toBe(false); // interior hole stays open
    expect(state.aggregates.get("2026-06-14")?.totalTokens).toBe(700); // gap day sealed
    expect(state.aggregates.get("2026-06-10")?.cost).toBeCloseTo(1.0, 10); // untouched
  });
});
