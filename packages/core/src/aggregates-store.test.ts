import { mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { aggregateRecordsByDay } from "./aggregates.js";
import {
  aggregatesStoreDir,
  DailyAccumulator,
  deleteDayFile,
  listDaysOnDisk,
  loadAggregates,
  migrateMonolithSnapshotIfNeeded,
  readDayFile,
  sealRolledOverDay,
  writeDayFile,
} from "./aggregates-store.js";
import { localDateKey } from "./date-utils.js";
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

function ts(date: string): number {
  return Date.parse(`${date}T12:00:00Z`);
}

describe("per-day store — write/read/list", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-store-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("empty store → listDaysOnDisk returns []", () => {
    expect(listDaysOnDisk(home)).toEqual([]);
  });

  test("writeDayFile then readDayFile round-trips exactly", () => {
    const [day] = aggregateRecordsByDay([
      r({ timestamp: ts("2026-05-20"), cost: 1.5, inputTokens: 100 }),
    ]);
    writeDayFile(home, day);
    const loaded = readDayFile(home, "2026-05-20");
    expect(loaded).toEqual(day);
  });

  test("listDaysOnDisk returns sorted dates, ignores non-date files", () => {
    const [d1] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-22"), cost: 1 })]);
    const [d2] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    const [d3] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-21"), cost: 1 })]);
    writeDayFile(home, d1);
    writeDayFile(home, d2);
    writeDayFile(home, d3);
    // Sprinkle in non-matching filenames; they must be ignored.
    writeFileSync(join(aggregatesStoreDir(home), "README.md"), "ignore me");
    writeFileSync(join(aggregatesStoreDir(home), "index.json"), "{}");
    writeFileSync(join(aggregatesStoreDir(home), "2026-13-99.json"), "{}");

    expect(listDaysOnDisk(home)).toEqual(["2026-05-20", "2026-05-21", "2026-05-22"]);
  });

  test("readDayFile returns null for a missing date", () => {
    expect(readDayFile(home, "2026-01-01")).toBeNull();
  });

  test("aggregate date keys cannot escape the private store", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    expect(() => writeDayFile(home, { ...day, date: "../../escaped" })).toThrow(
      "Invalid aggregate date key"
    );
    expect(() => readDayFile(home, "../../escaped")).toThrow("Invalid aggregate date key");
  });

  test("the embedded day must match its immutable filename", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    writeDayFile(home, day);
    const path = join(aggregatesStoreDir(home), "2026-05-20.json");
    writeFileSync(path, JSON.stringify({ ...day, date: "2026-05-21" }));
    expect(() => readDayFile(home, "2026-05-20")).toThrow(
      "Invalid sealed aggregate for 2026-05-20"
    );
  });

  test("an oversized sealed day is rejected before it can exhaust memory", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    writeDayFile(home, day);
    truncateSync(join(aggregatesStoreDir(home), "2026-05-20.json"), 64 * 1024 * 1024 + 1);
    expect(() => readDayFile(home, "2026-05-20")).toThrow(
      "Invalid sealed aggregate for 2026-05-20"
    );
  });

  test("a structurally valid JSON day with poisoned accounting totals is rejected", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    writeDayFile(home, day);
    const path = join(aggregatesStoreDir(home), "2026-05-20.json");
    writeFileSync(path, JSON.stringify({ ...day, totalTokens: day.totalTokens + 1 }));
    expect(() => readDayFile(home, "2026-05-20")).toThrow(
      "Invalid sealed aggregate for 2026-05-20"
    );
  });

  test("a poisoned sealed price card is rejected before a rebuild can use it", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    const poisoned = {
      ...day,
      prices: {
        "claude-sonnet-4-5": {
          source: "seeded" as const,
          card: { inputPerMillion: -1, outputPerMillion: 15 },
        },
      },
    };
    // The writer refuses to seal it…
    expect(() => writeDayFile(home, poisoned)).toThrow(
      "Refusing to seal an invalid aggregate for 2026-05-20"
    );
    // …and a file that got onto disk anyway is rejected on read.
    writeDayFile(home, day);
    writeFileSync(join(aggregatesStoreDir(home), "2026-05-20.json"), JSON.stringify(poisoned));
    expect(() => readDayFile(home, "2026-05-20")).toThrow(
      "Invalid sealed aggregate for 2026-05-20"
    );
  });

  test("loadAggregates returns a Map keyed by date with all days present", () => {
    for (const date of ["2026-05-20", "2026-05-21", "2026-05-22"]) {
      const [day] = aggregateRecordsByDay([r({ timestamp: ts(date), cost: 1 })]);
      writeDayFile(home, day);
    }
    const map = loadAggregates(home);
    expect(map.size).toBe(3);
    expect(map.has("2026-05-20")).toBe(true);
    expect(map.get("2026-05-21")?.cost).toBe(1);
  });

  test("loadAggregates({daysBack: N}) loads only the N most-recent", () => {
    for (const date of ["2026-05-18", "2026-05-19", "2026-05-20", "2026-05-21", "2026-05-22"]) {
      const [day] = aggregateRecordsByDay([r({ timestamp: ts(date), cost: 1 })]);
      writeDayFile(home, day);
    }
    const recent = loadAggregates(home, { daysBack: 2 });
    expect([...recent.keys()].sort()).toEqual(["2026-05-21", "2026-05-22"]);
  });

  test("a corrupt sealed day is quarantined and reported, never silently dropped", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    writeDayFile(home, day);
    // Write garbage in place of a valid day file.
    const corrupt = join(aggregatesStoreDir(home), "2026-05-21.json");
    writeFileSync(corrupt, "{not json");
    const warnings: string[] = [];
    const quarantined = new Set<string>();
    const map = loadAggregates(home, { onWarning: (m) => warnings.push(m), quarantined });
    // One bad day no longer takes the whole relay (and every report) down.
    expect([...map.keys()]).toEqual(["2026-05-20"]);
    expect([...quarantined]).toEqual(["2026-05-21"]);
    expect(warnings.some((m) => /Sealed day 2026-05-21 could not be read/.test(m))).toBe(true);
    expect(readFileSync(corrupt, "utf8")).toBe("{not json"); // never rewritten
  });

  test("a sealed day whose 1h cache-write share exceeds its total is repaired in memory", () => {
    // The real 2026-09-16 shape: Claude Code reported ephemeral_1h = 2050 with
    // cache_creation_input_tokens = 0 on three lines, and the sealed bucket
    // carried 1,802,192 (1h) > 1,800,142 (total). The reader used to reject
    // the day, and with it every history read.
    const [day] = aggregateRecordsByDay([
      r({
        timestamp: ts("2026-09-16"),
        cacheWriteTokens: 1_800_142,
        cacheWrite1hTokens: 1_800_142,
      }),
    ]);
    writeDayFile(home, day);
    const path = join(aggregatesStoreDir(home), "2026-09-16.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const bump = (b: { cacheWrite1hTokens?: number }) => {
      b.cacheWrite1hTokens = 1_802_192;
    };
    bump(raw);
    for (const m of Object.values(raw.models)) bump(m as never);
    for (const p of Object.values(raw.providers)) bump(p as never);
    for (const p of Object.values(raw.projects) as { modelBuckets: object }[]) {
      bump(p as never);
      for (const b of Object.values(p.modelBuckets)) bump(b as never);
    }
    writeFileSync(path, JSON.stringify(raw));
    const before = readFileSync(path, "utf8");

    const warnings: string[] = [];
    const map = loadAggregates(home, { onWarning: (m) => warnings.push(m) });
    const loaded = map.get("2026-09-16");
    expect(loaded?.cacheWrite1hTokens).toBe(1_800_142);
    expect(loaded?.models["claude-sonnet-4-5"]?.cacheWrite1hTokens).toBe(1_800_142);
    expect(
      loaded?.projects.demo?.modelBuckets["claude-code claude-sonnet-4-5"]?.cacheWrite1hTokens
    ).toBe(1_800_142);
    expect(loaded?.totalTokens).toBe(day.totalTokens); // totals untouched
    expect(loaded?.cost).toBe(day.cost);
    expect(warnings.some((m) => /2026-09-16: clamped the 1h cache-write share/.test(m))).toBe(true);
    expect(readFileSync(path, "utf8")).toBe(before); // never rewritten on read
  });

  test("writeDayFile refuses a day the reader would reject", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    expect(() => writeDayFile(home, { ...day, totalTokens: day.totalTokens + 1 })).toThrow(
      "Refusing to seal an invalid aggregate for 2026-05-20"
    );
    expect(listDaysOnDisk(home)).toEqual([]);
  });

  test("folding a record whose 1h share exceeds its writes clamps the share", () => {
    const [day] = aggregateRecordsByDay([
      r({ timestamp: ts("2026-09-16"), cacheWriteTokens: 0, cacheWrite1hTokens: 2050 }),
      r({ timestamp: ts("2026-09-16") + 1, cacheWriteTokens: 500, cacheWrite1hTokens: 400 }),
    ]);
    expect(day.cacheWrite1hTokens).toBe(400);
    expect(() => writeDayFile(home, day)).not.toThrow();
    const acc = new DailyAccumulator("2026-09-16");
    acc.fold(r({ timestamp: ts("2026-09-16"), cacheWriteTokens: 0, cacheWrite1hTokens: 2050 }));
    expect(acc.toAggregate().cacheWrite1hTokens ?? 0).toBe(0);
  });

  test("deleteDayFile removes the file; subsequent reads return null", () => {
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 1 })]);
    writeDayFile(home, day);
    expect(readDayFile(home, "2026-05-20")).not.toBeNull();
    deleteDayFile(home, "2026-05-20");
    expect(readDayFile(home, "2026-05-20")).toBeNull();
  });
});

describe("DailyAccumulator — the live leg of the relay", () => {
  test("starts empty", () => {
    const acc = new DailyAccumulator("2026-05-22");
    expect(acc.isEmpty()).toBe(true);
    expect(acc.date).toBe("2026-05-22");
    expect(acc.toAggregate().recordCount).toBe(0);
  });

  test("fold adds a record, updates totals at every level", () => {
    const acc = new DailyAccumulator("2026-05-22");
    const added = acc.fold(
      r({
        timestamp: ts("2026-05-22"),
        project: "p1",
        provider: "claude-code",
        model: "opus",
        inputTokens: 100,
        outputTokens: 50,
        cost: 1.5,
      })
    );
    expect(added).toBe(true);
    expect(acc.isEmpty()).toBe(false);
    const day = acc.toAggregate();
    expect(day.cost).toBe(1.5);
    expect(day.recordCount).toBe(1);
    expect(day.totalTokens).toBe(150);
    expect(day.models.opus.recordCount).toBe(1);
    expect(day.projects.p1.cost).toBe(1.5);
    expect(day.providers["claude-code"].recordCount).toBe(1);
  });

  test("foldAll across many records sums to the same as aggregateRecordsByDay", () => {
    const records = [
      r({ timestamp: ts("2026-05-22"), cost: 1, inputTokens: 10, model: "opus" }),
      r({ timestamp: ts("2026-05-22"), cost: 2, inputTokens: 20, model: "sonnet" }),
      r({ timestamp: ts("2026-05-22"), cost: 3, inputTokens: 30, model: "opus" }),
    ];
    const acc = new DailyAccumulator("2026-05-22");
    const added = acc.foldAll(records);
    expect(added).toBe(3);

    const fromBatch = aggregateRecordsByDay(records)[0];
    const fromFold = acc.toAggregate();
    expect(fromFold.cost).toBe(fromBatch.cost);
    expect(fromFold.totalTokens).toBe(fromBatch.totalTokens);
    expect(fromFold.models).toEqual(fromBatch.models);
    expect(fromFold.projects).toEqual(fromBatch.projects);
    expect(fromFold.providers).toEqual(fromBatch.providers);
  });

  test("duplicate fold (same fingerprint) is a no-op — today never grows from a re-emit", () => {
    // This is the key invariant: codex's fork-dedup may re-emit the same
    // logical record from a different sibling file. The accumulator MUST NOT
    // double-count.
    const acc = new DailyAccumulator("2026-05-22");
    const record = r({
      timestamp: ts("2026-05-22"),
      project: "p1",
      provider: "codex",
      model: "gpt-5",
      inputTokens: 100,
      outputTokens: 50,
      cost: 2,
    });
    expect(acc.fold(record)).toBe(true);
    expect(acc.fold(record)).toBe(false);
    expect(acc.fold(record)).toBe(false);
    const day = acc.toAggregate();
    expect(day.cost).toBe(2); // not 6
    expect(day.recordCount).toBe(1);
  });

  test("two records with same time but different tokens are both kept (not real duplicates)", () => {
    const acc = new DailyAccumulator("2026-05-22");
    acc.fold(r({ timestamp: ts("2026-05-22"), inputTokens: 100, cost: 1 }));
    acc.fold(r({ timestamp: ts("2026-05-22"), inputTokens: 200, cost: 2 }));
    expect(acc.toAggregate().recordCount).toBe(2);
  });

  test("seal returns a finalized aggregate with all totals filled in", () => {
    const acc = new DailyAccumulator("2026-05-22");
    acc.fold(r({ timestamp: ts("2026-05-22"), inputTokens: 100, outputTokens: 50, cost: 1 }));
    const sealed = acc.seal();
    expect(sealed.totalTokens).toBe(150);
    expect(sealed.models["claude-sonnet-4-5"].totalTokens).toBe(150);
    expect(Number.isFinite(sealed.firstUsed)).toBe(true);
    expect(Number.isFinite(sealed.lastUsed)).toBe(true);
  });

  test("hydrate restores from a pre-built aggregate seed", () => {
    const records = [r({ timestamp: ts("2026-05-22"), cost: 3, inputTokens: 30 })];
    const [seed] = aggregateRecordsByDay(records);
    const acc = new DailyAccumulator("2026-05-22");
    acc.hydrate(seed);
    expect(acc.toAggregate().cost).toBe(3);
    expect(acc.toAggregate().recordCount).toBe(1);
  });
});

describe("migrateMonolithSnapshotIfNeeded — one-shot v2/v3 → per-day", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-mig-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("migrates v2 records into per-day files, skipping today", () => {
    const todayKey = localDateKey();
    const records = [
      r({ timestamp: Date.parse("2024-01-15T10:00:00Z"), cost: 5 }),
      r({ timestamp: Date.parse("2024-01-16T10:00:00Z"), cost: 7 }),
      r({ timestamp: Date.now(), cost: 99 }), // today
    ];
    // Create a fake legacy snapshot file to migrate from.
    const legacyPath = join(home, "legacy.json");
    writeFileSync(legacyPath, "{}");
    const result = migrateMonolithSnapshotIfNeeded(home, legacyPath, () => ({ records }));
    expect(result.migrated).toBe(true);
    expect(result.daysWritten).toBe(2); // today excluded
    const onDisk = listDaysOnDisk(home);
    expect(onDisk).toContain("2024-01-15");
    expect(onDisk).toContain("2024-01-16");
    expect(onDisk).not.toContain(todayKey);
  });

  test("idempotent: no-op when per-day files already exist", () => {
    // Pre-populate the store.
    const [day] = aggregateRecordsByDay([r({ timestamp: ts("2024-01-15"), cost: 1 })]);
    writeDayFile(home, day);

    const legacyPath = join(home, "legacy.json");
    writeFileSync(legacyPath, "{}");
    const result = migrateMonolithSnapshotIfNeeded(home, legacyPath, () => ({
      records: [r({ timestamp: ts("2024-02-01"), cost: 9 })],
    }));
    expect(result.migrated).toBe(false);
    // The pre-existing per-day file untouched; no new files created.
    expect(listDaysOnDisk(home)).toEqual(["2024-01-15"]);
  });

  test("no-op when the legacy file doesn't exist", () => {
    const result = migrateMonolithSnapshotIfNeeded(home, join(home, "missing.json"), () => null);
    expect(result.migrated).toBe(false);
    expect(listDaysOnDisk(home)).toEqual([]);
  });

  test("accepts pre-aggregated v3 days directly (no re-aggregation)", () => {
    const days = aggregateRecordsByDay([
      r({ timestamp: ts("2024-01-15"), cost: 1 }),
      r({ timestamp: ts("2024-01-16"), cost: 2 }),
    ]);
    const legacyPath = join(home, "legacy.json");
    writeFileSync(legacyPath, "{}");
    const result = migrateMonolithSnapshotIfNeeded(home, legacyPath, () => ({ days }));
    expect(result.migrated).toBe(true);
    expect(result.daysWritten).toBe(2);
    expect(readDayFile(home, "2024-01-15")?.cost).toBe(1);
  });
});

describe("JSON round-trip — per-day file is lossless", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-rt-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("aggregate → writeDayFile → readDayFile produces a byte-identical aggregate", () => {
    const acc = new DailyAccumulator("2026-05-22");
    acc.foldAll([
      r({
        timestamp: ts("2026-05-22"),
        project: "p1",
        provider: "claude-code",
        model: "opus",
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 25,
        cost: 1.5,
      }),
      r({
        timestamp: ts("2026-05-22"),
        project: "p2",
        provider: "codex",
        model: "gpt-5",
        inputTokens: 200,
        outputTokens: 75,
        cost: 3,
      }),
    ]);
    const sealed = acc.seal();
    writeDayFile(home, sealed);
    const restored = readDayFile(home, "2026-05-22");
    expect(restored).toEqual(sealed);
  });
});

describe("sealRolledOverDay — midnight rollover persists yesterday", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "tokmeter-roll-"));
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("seals a complete past day to disk so it survives JSONL deletion", () => {
    const acc = new DailyAccumulator("2026-05-20");
    acc.fold(r({ timestamp: ts("2026-05-20"), cost: 2, inputTokens: 50 }));
    // Daemon ticks just after midnight → todayKey is the next day.
    const sealed = sealRolledOverDay(home, acc, "2026-05-21");
    expect(sealed?.date).toBe("2026-05-20");
    // The day is now on disk, independent of any raw JSONL.
    expect(readDayFile(home, "2026-05-20")?.cost).toBe(2);
    expect(listDaysOnDisk(home)).toEqual(["2026-05-20"]);
  });

  test("write-once: never clobbers a day already sealed on disk", () => {
    const [existing] = aggregateRecordsByDay([r({ timestamp: ts("2026-05-20"), cost: 99 })]);
    writeDayFile(home, existing);
    const acc = new DailyAccumulator("2026-05-20");
    acc.fold(r({ timestamp: ts("2026-05-20"), cost: 2 }));
    const sealed = sealRolledOverDay(home, acc, "2026-05-21");
    expect(sealed).toBeNull(); // skipped — already on disk
    expect(readDayFile(home, "2026-05-20")?.cost).toBe(99); // untouched
  });

  test("no-op when the accumulator is still today (no rollover happened)", () => {
    const acc = new DailyAccumulator("2026-05-21");
    acc.fold(r({ timestamp: ts("2026-05-21"), cost: 2 }));
    expect(sealRolledOverDay(home, acc, "2026-05-21")).toBeNull();
    expect(listDaysOnDisk(home)).toEqual([]);
  });

  test("no-op on an empty accumulator (a quiet day seals nothing)", () => {
    const acc = new DailyAccumulator("2026-05-20");
    expect(sealRolledOverDay(home, acc, "2026-05-21")).toBeNull();
    expect(listDaysOnDisk(home)).toEqual([]);
  });

  test("a persistence failure aborts rollover instead of returning an unsealed day", () => {
    const blockedHome = join(home, "not-a-directory");
    writeFileSync(blockedHome, "occupied");
    const acc = new DailyAccumulator("2026-05-20");
    acc.fold(r({ timestamp: ts("2026-05-20"), cost: 2 }));

    expect(() => sealRolledOverDay(blockedHome, acc, "2026-05-21")).toThrow();
  });
});

describe("DailyAccumulator.fold — malformed records can't poison totals", () => {
  test("drops NaN / Infinity / negative numeric fields", () => {
    const acc = new DailyAccumulator("2026-05-22");
    const bad: Array<Partial<TokenRecord>> = [
      { inputTokens: Number.NaN },
      { outputTokens: Number.POSITIVE_INFINITY },
      { cacheReadTokens: -5 },
      { cost: Number.NaN },
      { cost: -1 },
      { reasoningTokens: Number.NEGATIVE_INFINITY },
      { timestamp: Number.NaN },
    ];
    for (const o of bad) {
      // timestamp default is overridden last in r(); set it explicitly so the
      // NaN-timestamp case actually exercises the timestamp guard.
      const rec = r({ timestamp: ts("2026-05-22"), ...o }) as TokenRecord;
      if (o.timestamp !== undefined) rec.timestamp = o.timestamp;
      expect(acc.fold(rec)).toBe(false);
    }
    expect(acc.isEmpty()).toBe(true);
    const day = acc.toAggregate();
    expect(day.recordCount).toBe(0);
    expect(day.cost).toBe(0);
    expect(day.totalTokens).toBe(0);
  });

  test("drops a record with an empty model id (no junk bucket created)", () => {
    const acc = new DailyAccumulator("2026-05-22");
    expect(acc.fold(r({ timestamp: ts("2026-05-22"), model: "", cost: 1 }))).toBe(false);
    expect(acc.toAggregate().recordCount).toBe(0);
    expect(Object.keys(acc.toAggregate().models)).toEqual([]);
  });

  test("a bad record between two good ones doesn't disturb the running total", () => {
    const acc = new DailyAccumulator("2026-05-22");
    expect(acc.fold(r({ timestamp: ts("2026-05-22"), inputTokens: 10, cost: 1 }))).toBe(true);
    expect(acc.fold(r({ timestamp: ts("2026-05-22"), inputTokens: Number.NaN, cost: 999 }))).toBe(
      false
    );
    expect(acc.fold(r({ timestamp: ts("2026-05-22"), inputTokens: 20, cost: 2 }))).toBe(true);
    const day = acc.toAggregate();
    expect(day.recordCount).toBe(2);
    expect(day.cost).toBe(3);
    expect(day.totalTokens).toBe(30);
  });
});
