import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { aggregateRecordsByDay } from "./aggregates.js";
import {
  HISTORY_FLOOR_RATIO,
  loadHistorySnapshot,
  saveHistorySnapshot,
  saveHistorySnapshotV3,
  shouldKeepExistingHistory,
  sumAggregateTokens,
  sumSnapshotTokens,
} from "./history-snapshot.js";
import type { TokenRecord } from "./types.js";

/** Minimal frozen record — only the fields the snapshot layer touches. */
function rec(overrides: Partial<TokenRecord> & Pick<TokenRecord, "timestamp">): TokenRecord {
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

describe("history-snapshot — load/save round-trip", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-snap-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("missing snapshot reports none", () => {
    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.historySource).toBe("none");
    expect(loaded.records).toEqual([]);
    expect(loaded.matchesExpected).toBe(false);
    expect(loaded.storedStableThrough).toBeNull();
  });

  test("exact stableThrough match reuses records verbatim", () => {
    const records = [rec({ timestamp: Date.parse("2026-05-21T10:00:00Z"), cost: 12.5 })];
    saveHistorySnapshot(home, "2026-05-21", records);

    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.historySource).toBe("snapshot");
    expect(loaded.matchesExpected).toBe(true);
    expect(loaded.storedStableThrough).toBe("2026-05-21");
    expect(loaded.records).toHaveLength(1);
    expect(loaded.records[0].cost).toBe(12.5);
  });

  test("STALE snapshot (frozen through an earlier day) stays usable, not discarded", () => {
    // This is the heart of the append-only fix: a snapshot frozen yesterday must
    // survive today's rollover so its frozen records can be reused as the base,
    // instead of being thrown away and re-derived (and re-priced) from disk.
    const records = [rec({ timestamp: Date.parse("2026-05-20T10:00:00Z"), cost: 99 })];
    saveHistorySnapshot(home, "2026-05-20", records);

    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.historySource).toBe("snapshot"); // NOT "none"
    expect(loaded.matchesExpected).toBe(false);
    expect(loaded.storedStableThrough).toBe("2026-05-20");
    expect(loaded.records[0].cost).toBe(99); // frozen cost preserved
  });
});

describe("v2 reads also expose derived aggregates (transition compatibility)", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-snap-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("v2 snapshot → records populated AND aggregates derived from same records", () => {
    const records = [
      rec({
        timestamp: Date.parse("2026-05-20T10:00:00Z"),
        cost: 10,
        inputTokens: 100,
        outputTokens: 50,
      }),
      rec({
        timestamp: Date.parse("2026-05-21T14:00:00Z"),
        cost: 20,
        inputTokens: 200,
        outputTokens: 75,
      }),
    ];
    saveHistorySnapshot(home, "2026-05-21", records);

    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.loadedVersion).toBe(2);
    expect(loaded.records).toHaveLength(2);
    // Derived aggregates: one row per distinct day, totals match record sums.
    expect(loaded.aggregates).toHaveLength(2);
    const total = loaded.aggregates.reduce((s, d) => s + d.cost, 0);
    expect(total).toBe(30);
    // sumAggregateTokens matches sumSnapshotTokens for the same data — proves
    // the floor-guard math is interchangeable across schema versions.
    expect(sumAggregateTokens(loaded.aggregates)).toBe(sumSnapshotTokens(records));
  });
});

describe("v3 snapshot — aggregate on-disk format", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-snap-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("saveHistorySnapshotV3 round-trips: aggregates → file → loadHistorySnapshot returns same", () => {
    const records = [
      rec({
        timestamp: Date.parse("2026-05-20T10:00:00Z"),
        cost: 12,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
      }),
      rec({
        timestamp: Date.parse("2026-05-21T11:00:00Z"),
        cost: 8,
        inputTokens: 80,
        outputTokens: 40,
      }),
    ];
    const days = aggregateRecordsByDay(records);
    saveHistorySnapshotV3(home, "2026-05-21", days);

    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.loadedVersion).toBe(3);
    expect(loaded.records).toEqual([]); // v3 exposes no raw records
    expect(loaded.aggregates).toEqual(days);
    expect(loaded.storedStableThrough).toBe("2026-05-21");
    expect(loaded.matchesExpected).toBe(true);
  });

  test("v3 STALE snapshot (frozen through earlier day) stays usable, append-only contract intact", () => {
    const days = aggregateRecordsByDay([
      rec({ timestamp: Date.parse("2026-05-19T10:00:00Z"), cost: 5 }),
    ]);
    saveHistorySnapshotV3(home, "2026-05-19", days);

    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.loadedVersion).toBe(3);
    expect(loaded.historySource).toBe("snapshot");
    expect(loaded.matchesExpected).toBe(false);
    expect(loaded.storedStableThrough).toBe("2026-05-19");
    expect(loaded.aggregates[0].cost).toBe(5);
  });

  test("unsupported version → historySource:none (rebuild from disk)", () => {
    // Synthesize a v7-from-the-future snapshot file directly.
    mkdirSync(join(home, ".cache", "tokmeter"), { recursive: true });
    writeFileSync(
      join(home, ".cache", "tokmeter", "history-snapshot.json"),
      JSON.stringify({ version: 7, stableThrough: "2026-05-21", days: [] }),
      "utf-8"
    );
    const loaded = loadHistorySnapshot(home, "2026-05-21");
    expect(loaded.historySource).toBe("none");
    expect(loaded.loadedVersion).toBeNull();
    expect(loaded.warnings.some((w) => w.message.includes("version 7"))).toBe(true);
  });
});

describe("sumSnapshotTokens", () => {
  test("adds every bucket across records", () => {
    const total = sumSnapshotTokens([
      rec({
        timestamp: 1,
        inputTokens: 10,
        outputTokens: 20,
        cacheReadTokens: 30,
        cacheWriteTokens: 40,
        reasoningTokens: 50,
      }),
      rec({ timestamp: 2, inputTokens: 5 }),
    ]);
    expect(total).toBe(155);
  });

  test("empty set is zero", () => {
    expect(sumSnapshotTokens([])).toBe(0);
  });
});

describe("shouldKeepExistingHistory — monotonic floor guard", () => {
  const clean = { forceRescan: false, providerFailed: false };

  test("explicit rescan always replaces (user asked for fresh truth)", () => {
    expect(shouldKeepExistingHistory(100, 1, { forceRescan: true, providerFailed: true })).toBe(
      false
    );
  });

  test("nothing to protect when existing is empty", () => {
    expect(shouldKeepExistingHistory(0, 0, clean)).toBe(false);
  });

  test("a provider failure keeps the existing snapshot even on a small dip", () => {
    // 31.35B → 13.58B style loss caused by a provider dropping out mid-scan.
    expect(
      shouldKeepExistingHistory(31_350, 13_580, { forceRescan: false, providerFailed: true })
    ).toBe(true);
  });

  test("catastrophic shrink below the floor keeps the snapshot", () => {
    // 13.58 / 31.35 = 0.43 < 0.5 floor → reject the rebuild.
    expect(shouldKeepExistingHistory(31_350, 13_580, clean)).toBe(true);
  });

  test("modest parser-correctness drift above the floor is allowed through", () => {
    // A 10% dedup correction (e.g. codex forked-rollout fix) must not be blocked.
    expect(shouldKeepExistingHistory(1000, 900, clean)).toBe(false);
  });

  test("the floor sits exactly at HISTORY_FLOOR_RATIO", () => {
    const existing = 1000;
    const justBelow = existing * HISTORY_FLOOR_RATIO - 1;
    const justAbove = existing * HISTORY_FLOOR_RATIO + 1;
    expect(shouldKeepExistingHistory(existing, justBelow, clean)).toBe(true);
    expect(shouldKeepExistingHistory(existing, justAbove, clean)).toBe(false);
  });
});
