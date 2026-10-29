// Regression tests for the 2026-10-29 accounting audit, through the real
// TokmeterCore / relay paths with synthetic sessions in a temp HOME.
//
// The record cache resolves its directory from HOME when parsers/utils loads,
// so HOME points at a scratch dir BEFORE the core is imported; otherwise these
// runs would write into the real ~/.cache/tokmeter.

import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { DayPrices } from "./day-prices.js";
import type { TokmeterCore as Core, ScanWarning } from "./index.js";
import type { PricingService } from "./pricing.js";
import type { ScanContext } from "./scan-pipeline.js";

const realHome = process.env.HOME;
const scratchHome = mkdtempSync(join(tmpdir(), "tokmeter-audit-cache-"));
let TokmeterCore: typeof Core;
let store: typeof import("./aggregates-store.js");
let relay: typeof import("./relay-loader.js");
let aggregates: typeof import("./aggregates.js");

beforeAll(async () => {
  process.env.HOME = scratchHome;
  ({ TokmeterCore } = await import("./tokmeter-core.js"));
  store = await import("./aggregates-store.js");
  relay = await import("./relay-loader.js");
  aggregates = await import("./aggregates.js");
});
afterAll(() => {
  process.env.HOME = realHome;
  rmSync(scratchHome, { recursive: true, force: true });
});

let home: string;
let dir: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-audit-"));
  dir = join(home, ".claude", "projects", "-tmp-app");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
});

// Local-time literals: vitest and bun test run in different timezones.
const at = (s: string) => new Date(s).getTime();

function line(id: string, ts: number, out: number): string {
  return JSON.stringify({
    type: "assistant",
    uuid: `u-${id}`,
    requestId: `req_${id}`,
    timestamp: new Date(ts).toISOString(),
    message: {
      id: `msg_${id}`,
      model: "claude-x",
      usage: {
        input_tokens: 10,
        output_tokens: out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      content: [{ type: "text" }],
    },
  });
}

/** A session file whose mtime is its last write, like the real thing. */
function session(name: string, lines: string[], mtime: number): string {
  const file = join(dir, name);
  writeFileSync(file, `${lines.join("\n")}\n`);
  utimesSync(file, new Date(mtime), new Date(mtime));
  return file;
}

const skipPricingCtx = (homeDir: string): ScanContext => ({
  homeDir,
  pricing: { init: async () => {}, getRegistryMtime: () => 0 } as unknown as PricingService,
  skipPricing: true,
});

describe("midnight seal", () => {
  test("seals a record written after the last pre-midnight tick in a file not touched again", async () => {
    // Real 2026-10-28: the bar polls every 300 s, the last tick ran ~23:56,
    // four Codex responses landed 23:57–23:58 in files not written again
    // before the 00:00:04 seal, and the midnight-floored scan never read them.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-28T23:50:00"));
    session("a.jsonl", [line("A", at("2026-10-28T23:40:00"), 700)], at("2026-10-28T23:40:00"));
    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();

    // Written at 23:57 — after that tick, before midnight — and never again.
    session("b.jsonl", [line("B", at("2026-10-28T23:57:44"), 90)], at("2026-10-28T23:57:44"));

    vi.setSystemTime(at("2026-10-29T00:00:04"));
    await daemon.refreshToday(at("2026-10-29T00:00:04"));
    const sealed = daemon.getDailyAggregates().find((day) => day.date === "2026-10-28");
    expect(sealed?.recordCount).toBe(2);
    expect(sealed?.outputTokens).toBe(790);
    expect(store.readDayFile(home, "2026-10-28")?.outputTokens).toBe(790);
  });

  test("a fault in a file that can't hold the outgoing day doesn't stall the seal", async () => {
    // A file whose unread part is newer than its last record (dated today)
    // can't hide yesterday's records. Any provider warning used to keep
    // yesterday unsealed and the accumulator frozen on it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at("2026-10-28T23:50:00"));
    session("a.jsonl", [line("A", at("2026-10-28T23:40:00"), 700)], at("2026-10-28T23:40:00"));
    const daemon = new TokmeterCore({ homeDir: home, skipPricing: true });
    await daemon.scan();

    const today = join(dir, "today.jsonl");
    writeFileSync(today, `${line("T", at("2026-10-29T00:00:01"), 5)}\n{"type":"assistant","mess`);
    utimesSync(today, new Date(at("2026-10-29T00:00:03")), new Date(at("2026-10-29T00:00:03")));

    vi.setSystemTime(at("2026-10-29T00:00:04"));
    await daemon.refreshToday(at("2026-10-29T00:00:04"));
    expect(daemon.getScanMeta().warnings.some((w) => /still being written/.test(w.message))).toBe(
      true
    );
    const sealed = daemon.getDailyAggregates().find((day) => day.date === "2026-10-28");
    expect(sealed?.outputTokens).toBe(700);
    expect(daemon.getTodayAggregate()?.date).toBe("2026-10-29");
    expect(daemon.getTodayAggregate()?.outputTokens).toBe(5);
  });

  test("seals with the cards the day was priced at even when kosha changed since", async () => {
    // Every rollover seal from 2026-10-21 on carried no price cards: kosha
    // rewrites its registry during the day, so at the midnight tick the
    // registry had moved and the seal gave up on cards.
    const daemon = new TokmeterCore({ homeDir: home, skipPricing: false });
    const internals = daemon as unknown as {
      todayAccumulator: InstanceType<typeof store.DailyAccumulator> | null;
      lastPricedCards: { date: string; prices: DayPrices } | null;
      pricesForSeal(
        now: number,
        stragglers: never[],
        koshaChanged: boolean
      ): Promise<DayPrices | undefined>;
    };
    const acc = new store.DailyAccumulator("2026-10-28");
    internals.todayAccumulator = acc;
    const cards: DayPrices = {
      "claude-x": { card: { inputPerMillion: 4, outputPerMillion: 20 }, source: "kosha-exact" },
    };
    internals.lastPricedCards = { date: "2026-10-28", prices: cards };
    const prices = await internals.pricesForSeal(at("2026-10-29T00:00:04"), [], true);
    expect(prices).toEqual(cards);
    // Cards captured for another day can't vouch for this one.
    internals.lastPricedCards = { date: "2026-10-27", prices: cards };
    expect(await internals.pricesForSeal(at("2026-10-29T00:00:04"), [], true)).toBeUndefined();
  });
});

describe("relay persistence under faults", () => {
  test("one bad sealed day is quarantined; the rest of history still loads", async () => {
    const good = aggregates.aggregateRecordsByDay([
      {
        timestamp: at("2026-10-27T12:00:00"),
        provider: "claude-code",
        model: "claude-x",
        project: "demo",
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 0,
      },
    ])[0]!;
    store.writeDayFile(home, good);
    writeFileSync(join(store.aggregatesStoreDir(home), "2026-10-26.json"), "{broken");
    const warnings: ScanWarning[] = [];
    const state = await relay.refreshFromRelay(
      skipPricingCtx(home),
      at("2026-10-28T12:00:00"),
      warnings,
      false
    );
    expect(state.aggregates.has("2026-10-27")).toBe(true);
    expect(state.aggregates.has("2026-10-26")).toBe(false);
    expect(warnings.some((w) => /Sealed day 2026-10-26 could not be read/.test(w.message))).toBe(
      true
    );
  });

  test("a full rebuild persists every day a faulting file can't hold", async () => {
    // Fresh install on a corpus with one bad file: the rebuild used to persist
    // nothing at all, so `daily --since yesterday --json` omitted yesterday
    // and every start redid the full rebuild.
    session(
      "good.jsonl",
      [line("D1", at("2026-10-26T12:00:00"), 100), line("D2", at("2026-10-27T12:00:00"), 200)],
      at("2026-10-27T12:00:00")
    );
    // A malformed usage line (possible lost usage) in a file last written on
    // the 26th: it can hide records of the 26th, never of the 27th.
    session(
      "bad.jsonl",
      [line("X", at("2026-10-26T09:00:00"), 50), '{"type":"assistant","message":{"usage":{"inp'],
      at("2026-10-26T13:00:00")
    );
    const warnings: ScanWarning[] = [];
    const state = await relay.refreshFromRelay(
      skipPricingCtx(home),
      at("2026-10-28T12:00:00"),
      warnings,
      false
    );
    expect(store.listDaysOnDisk(home)).toEqual(["2026-10-27"]);
    expect(state.aggregates.get("2026-10-27")?.outputTokens).toBe(200);
    expect(
      warnings.some((w) => /not persisted for 1 day\(s\) \(2026-10-26\)/.test(w.message))
    ).toBe(true);
  });
});
