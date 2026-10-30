import { describe, expect, test } from "vitest";
import { aggregateRecordsByDay, type DailyAggregate } from "./aggregates.js";
import { localDateKey } from "./date-utils.js";
import { computeStatbarSignals } from "./signals.js";
import { computeTimeOfDayProfile, TIME_OF_DAY_MIN_DAYS } from "./time-of-day.js";
import type { TokenRecord } from "./types.js";

// Every timestamp is a LOCAL wall-clock literal: vitest and bun test run in
// different timezones, so UTC instants near midnight would land on different
// days under the two runners. "now" sits at local midday.
const now = new Date(2026, 9, 30, 12, 0, 0).getTime();

function rec(timestamp: number, cost: number): TokenRecord {
  return {
    project: "demo",
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    inputTokens: 10,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost,
    timestamp,
  };
}

/** N days back from 2026-10-30, at the given local hour. */
function at(daysBack: number, hour: number, minute = 0): number {
  return new Date(2026, 9, 30 - daysBack, hour, minute, 0).getTime();
}

/** Days 1…n back, each with the same per-hour spend. */
function days(n: number, spend: Array<[hour: number, cost: number]>, offset = 1): DailyAggregate[] {
  const records: TokenRecord[] = [];
  for (let d = offset; d < offset + n; d++) {
    for (const [hour, cost] of spend) records.push(rec(at(d, hour, 30), cost));
  }
  return aggregateRecordsByDay(records);
}

describe("computeTimeOfDayProfile", () => {
  test("splits cost into eight 3-hour blocks and names the peak", () => {
    // Each day: $1 at 02:30 (00–03), $3 at 16:30 (15–18), $4 at 22:30 (21–24).
    const aggs = days(10, [
      [2, 1],
      [16, 3],
      [22, 4],
    ]);
    const p = computeTimeOfDayProfile(aggs, now);
    expect(p.status).toBe("ok");
    expect(p.daysCounted).toBe(10);
    expect(p.daysSkipped).toBe(0);
    expect(p.totalCost).toBeCloseTo(80, 10);
    expect(p.blocks.map((b) => [b.startHour, b.endHour])).toEqual([
      [0, 3],
      [3, 6],
      [6, 9],
      [9, 12],
      [12, 15],
      [15, 18],
      [18, 21],
      [21, 24],
    ]);
    expect(p.blocks.map((b) => b.share)).toEqual([0.125, 0, 0, 0, 0, 0.375, 0, 0.5]);
    expect(p.blocks.reduce((s, b) => s + b.share, 0)).toBeCloseTo(1, 12);
    expect(p.peak).toMatchObject({ startHour: 21, endHour: 24, cost: 40, share: 0.5 });
  });

  test("block edges: hour 2 is 00–03, hour 3 opens 03–06, hour 23 is 21–24", () => {
    const aggs = days(TIME_OF_DAY_MIN_DAYS, [
      [2, 1],
      [3, 2],
      [23, 1],
    ]);
    const p = computeTimeOfDayProfile(aggs, now);
    expect(p.blocks[0].cost).toBeCloseTo(7, 10);
    expect(p.blocks[1].cost).toBeCloseTo(14, 10);
    expect(p.blocks[7].cost).toBeCloseTo(7, 10);
    expect(p.peak?.startHour).toBe(3);
  });

  test("excludes today, even when today's live curve is in the list", () => {
    const past = days(TIME_OF_DAY_MIN_DAYS, [[10, 1]]);
    const today = aggregateRecordsByDay([rec(at(0, 8), 1000)]);
    expect(today[0].date).toBe(localDateKey(now));
    const p = computeTimeOfDayProfile([...past, ...today], now);
    expect(p.totalCost).toBeCloseTo(7, 10);
    expect(p.peak?.startHour).toBe(9);
  });

  test("only the 30 calendar days before today count", () => {
    const inside = days(TIME_OF_DAY_MIN_DAYS, [[10, 1]], 24); // days 24…30 back
    const outside = aggregateRecordsByDay([rec(at(31, 22), 500)]);
    const p = computeTimeOfDayProfile([...inside, ...outside], now);
    expect(p.daysCounted).toBe(TIME_OF_DAY_MIN_DAYS);
    expect(p.totalCost).toBeCloseTo(7, 10);
    expect(p.blocks[7].cost).toBe(0);
  });

  test("days without costByHour are skipped, never counted as $0", () => {
    const curved = days(TIME_OF_DAY_MIN_DAYS, [[13, 2]]);
    const legacy = days(5, [[1, 99]], 10);
    for (const d of legacy) d.costByHour = undefined; // pre-curve sealed files
    const p = computeTimeOfDayProfile([...curved, ...legacy], now);
    expect(p.status).toBe("ok");
    expect(p.daysCounted).toBe(TIME_OF_DAY_MIN_DAYS);
    expect(p.daysSkipped).toBe(5);
    expect(p.totalCost).toBeCloseTo(14, 10);
    expect(p.blocks[0].cost).toBe(0);
  });

  test("a curve that doesn't add up to the day's cost is skipped", () => {
    // A legacy day that took one straggler fold: the curve holds only the
    // straggler's $1 while the day booked $50. Its shape would mislead.
    const curved = days(TIME_OF_DAY_MIN_DAYS, [[13, 2]]);
    const partial = days(1, [[1, 1]], 12);
    partial[0].cost = 50;
    const p = computeTimeOfDayProfile([...curved, ...partial], now);
    expect(p.daysSkipped).toBe(1);
    expect(p.blocks[0].cost).toBe(0);
  });

  test("not enough data below the minimum number of curved days", () => {
    const aggs = days(TIME_OF_DAY_MIN_DAYS - 1, [[16, 5]]);
    const p = computeTimeOfDayProfile(aggs, now);
    expect(p.status).toBe("insufficient");
    expect(p.daysCounted).toBe(TIME_OF_DAY_MIN_DAYS - 1);
    expect(p.blocks).toEqual([]);
    expect(p.peak).toBeNull();
    expect(p.totalCost).toBe(0);
  });

  test("zero-spend curved days don't count toward the minimum", () => {
    const spent = days(TIME_OF_DAY_MIN_DAYS - 1, [[16, 5]]);
    const zero = days(5, [[16, 0]], 10);
    const p = computeTimeOfDayProfile([...spent, ...zero], now);
    expect(p.status).toBe("insufficient");
    expect(p.daysCounted).toBe(TIME_OF_DAY_MIN_DAYS - 1);
  });

  test("a duplicated date is counted once", () => {
    const aggs = days(TIME_OF_DAY_MIN_DAYS, [[16, 1]]);
    const p = computeTimeOfDayProfile([...aggs, ...aggs], now);
    expect(p.daysCounted).toBe(TIME_OF_DAY_MIN_DAYS);
    expect(p.totalCost).toBeCloseTo(TIME_OF_DAY_MIN_DAYS, 10);
  });

  test("statbar signals carry the profile from the relay aggregates", () => {
    const aggs = days(8, [[19, 2]]);
    const s = computeStatbarSignals([], now, aggs);
    expect(s.timeOfDay?.status).toBe("ok");
    expect(s.timeOfDay?.peak).toMatchObject({ startHour: 18, endHour: 21, share: 1 });
    expect(computeStatbarSignals([], now).timeOfDay?.status).toBe("insufficient");
  });
});
