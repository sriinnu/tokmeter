/**
 * Relay accuracy guarantees — regression tests locking in the invariants the
 * relay must never violate: the cold-scan rebuild must be byte-identical to
 * the live fold (nothing lost, nothing hallucinated), and untrusted map keys
 * must never pollute Object.prototype or crash aggregation.
 */

import { afterEach, describe, expect, test } from "vitest";
import { iterateAllDays } from "./aggregate-consumers.js";
import { DailyAccumulator } from "./aggregates-store.js";
import { type DailyAggregate, aggregateRecordsByDay } from "./aggregates.js";
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

describe("relay accuracy — cold-scan/live-fold parity", () => {
  test("gap-fill rebuild collapses duplicate/fork records identically to live fold", () => {
    // Same logical turn re-emitted from a sibling file (Codex fork-dedup case):
    // identical content, so identical fingerprint → must count once in BOTH
    // paths. sourceFile differs but is excluded from the fingerprint.
    const dup = { timestamp: ts("2026-05-20"), cost: 0.5, inputTokens: 100, outputTokens: 40 };
    const records: TokenRecord[] = [
      r({ ...dup, sourceFile: "a.jsonl" } as Partial<TokenRecord> & { timestamp: number }),
      r({ ...dup, sourceFile: "b.jsonl" } as Partial<TokenRecord> & { timestamp: number }),
      r({ timestamp: ts("2026-05-20"), cost: 0.25, inputTokens: 50 }),
    ];

    // Live fold.
    const acc = new DailyAccumulator("2026-05-20");
    const added = acc.foldAll(records);
    const live = acc.seal();

    // Cold-scan rebuild.
    const [cold] = aggregateRecordsByDay(records);

    expect(added).toBe(2); // one duplicate dropped
    expect(cold.cost).toBeCloseTo(0.75, 10); // 0.5 + 0.25, NOT 1.25
    expect(cold.recordCount).toBe(2);
    // The two paths must agree on every top-level total.
    expect(cold.cost).toBeCloseTo(live.cost, 10);
    expect(cold.recordCount).toBe(live.recordCount);
    expect(cold.inputTokens).toBe(live.inputTokens);
    expect(cold.outputTokens).toBe(live.outputTokens);
  });
});

describe("relay accuracy — prototype safety", () => {
  afterEach(() => {
    // Fail loudly if any test polluted the global prototype.
    expect((Object.prototype as Record<string, unknown>).cost).toBeUndefined();
    expect((Object.prototype as Record<string, unknown>).inputTokens).toBeUndefined();
  });

  test("cold scan: __proto__/constructor keys do not pollute or crash, data preserved", () => {
    const records: TokenRecord[] = [
      r({ timestamp: ts("2026-05-20"), model: "__proto__", cost: 0.1, inputTokens: 10 }),
      r({ timestamp: ts("2026-05-20"), project: "constructor", cost: 0.2, inputTokens: 20 }),
      r({
        timestamp: ts("2026-05-20"),
        provider: "prototype" as TokenRecord["provider"],
        cost: 0.3,
        inputTokens: 30,
      }),
      r({ timestamp: ts("2026-05-20"), model: "real-model", cost: 0.4, inputTokens: 40 }),
    ];
    const [day] = aggregateRecordsByDay(records);
    expect(day.cost).toBeCloseTo(1.0, 10); // nothing lost
    expect("__proto__" in day.models).toBe(true);
    expect("constructor" in day.projects).toBe(true);
  });

  test("live fold (DailyAccumulator.fold): __proto__/constructor keys are safe", () => {
    const acc = new DailyAccumulator("2026-05-20");
    acc.fold(r({ timestamp: ts("2026-05-20"), model: "__proto__", cost: 0.1, inputTokens: 10 }));
    acc.fold(r({ timestamp: ts("2026-05-20"), project: "constructor", cost: 0.2, inputTokens: 20 }));
    const day = acc.seal();
    expect(day.cost).toBeCloseTo(0.3, 10);
    expect("__proto__" in day.models).toBe(true);
    expect("constructor" in day.projects).toBe(true);
  });
});

describe("relay accuracy — midnight rollover seals the outgoing day dedup-correctly", () => {
  // Reproduces the REAL rollover path: the outgoing day is re-derived by
  // aggregating the union of the last-seen recent records + freshly-scanned
  // stragglers (what refreshTodayAccumulator does). This is NOT folding into
  // the hydrated accumulator — hydrate() clears the fingerprint set, so folding
  // an already-counted straggler would double-count it into the immutable day.
  const day = "2026-06-30";

  // Mirror of the tokmeter-core rollover logic under test.
  function sealOutgoing(recentRecords: TokenRecord[], stragglers: TokenRecord[]) {
    const prev = new DailyAccumulator(day);
    // In production `prev` is hydrated (totals only, fingerprints CLEARED).
    prev.hydrate(aggregateRecordsByDay(recentRecords).find((d) => d.date === day)!);
    const outgoing = [...recentRecords, ...stragglers].filter(
      (r0) => localDateKey(r0.timestamp) === prev.date
    );
    const derived = aggregateRecordsByDay(outgoing).find((d) => d.date === prev.date);
    const toSeal = new DailyAccumulator(prev.date);
    toSeal.hydrate(derived ?? prev.toAggregate());
    return toSeal.seal();
  }

  test("late straggler is captured AND already-counted records are not double-counted", () => {
    // Recent records = what was counted pre-midnight (two lines). Local-time
    // literals (no `Z`) anchored midday keep localDateKey === `day` in ANY
    // timezone — UTC times near midnight would roll to the next local day under
    // a nonzero offset and silently drop from the outgoing filter.
    const recent: TokenRecord[] = [
      r({ timestamp: Date.parse(`${day}T09:00:00`), cost: 1.0, inputTokens: 100 }),
      r({ timestamp: Date.parse(`${day}T21:00:00`), cost: 0.5, inputTokens: 50 }),
    ];
    // Post-midnight scan re-reads the active file: the two already-counted lines
    // (must dedup) AND the late 21:05 line (must be captured).
    const stragglers: TokenRecord[] = [
      r({ timestamp: Date.parse(`${day}T09:00:00`), cost: 1.0, inputTokens: 100 }), // dup
      r({ timestamp: Date.parse(`${day}T21:00:00`), cost: 0.5, inputTokens: 50 }), // dup
      r({ timestamp: Date.parse(`${day}T21:05:00`), cost: 0.7, inputTokens: 70 }), // late
    ];
    const sealed = sealOutgoing(recent, stragglers);
    // 1.0 + 0.5 + 0.7 = 2.2 exactly — dups collapsed, late line kept once.
    expect(sealed.cost).toBeCloseTo(2.2, 10);
    expect(sealed.recordCount).toBe(3); // not 5 (double-count), not 2 (loss)
    expect(sealed.inputTokens).toBe(220);
  });

  test("no stragglers → sealed day equals what was already counted (no change)", () => {
    const recent: TokenRecord[] = [
      r({ timestamp: Date.parse(`${day}T10:00:00`), cost: 2.0, inputTokens: 200 }),
    ];
    const sealed = sealOutgoing(recent, []);
    expect(sealed.cost).toBeCloseTo(2.0, 10);
    expect(sealed.recordCount).toBe(1);
  });
});

describe("relay accuracy — no double-count when a date is in both the map and the accumulator", () => {
  test("iterateAllDays counts a day once when the sealed map and live accumulator share its date", () => {
    // Backward-clock / reloaded-seal scenario: the same date lives in the
    // sealed aggregates map AND is the live accumulator's date.
    const [sealed] = aggregateRecordsByDay([
      r({ timestamp: ts("2026-07-01"), cost: 1.0, inputTokens: 100 }),
    ]);
    const map = new Map<string, DailyAggregate>([["2026-07-01", sealed]]);

    const acc = new DailyAccumulator("2026-07-01");
    acc.fold(r({ timestamp: ts("2026-07-01"), cost: 1.0, inputTokens: 100 }));

    const days = [...iterateAllDays(map, acc)];
    const forDate = days.filter((d) => d.date === "2026-07-01");
    expect(forDate).toHaveLength(1); // counted once, not twice
    // The live accumulator wins as the single owner.
    expect(forDate[0].cost).toBeCloseTo(1.0, 10);
  });

  test("iterateAllDays yields distinct historical days plus today", () => {
    const [d1] = aggregateRecordsByDay([r({ timestamp: ts("2026-06-30"), cost: 0.5 })]);
    const map = new Map<string, DailyAggregate>([["2026-06-30", d1]]);
    const acc = new DailyAccumulator("2026-07-01");
    acc.fold(r({ timestamp: ts("2026-07-01"), cost: 0.7 }));
    const days = [...iterateAllDays(map, acc)];
    expect(days.map((d) => d.date).sort()).toEqual(["2026-06-30", "2026-07-01"]);
  });
});
