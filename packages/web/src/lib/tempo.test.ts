import { describe, expect, it } from "vitest";
import type { TokmeterDailyEntry, TokmeterScanMeta } from "../hooks/useTokmeterData.js";
import { computeSpendTempo } from "./tempo.js";

const meta: TokmeterScanMeta = {
  stableThrough: "2026-10-13",
  historySource: "snapshot",
  todayState: "live",
  lastScanAt: 0,
  warnings: [],
};
const day = (date: string, cost: number) => ({ date, cost }) as TokmeterDailyEntry;
// 15 Oct 2026, 12:00 local: 12 elapsed hours.
const NOON = new Date(2026, 9, 15, 12, 0, 0).getTime();
const history = [
  day("2026-10-06", 24), // $1/h
  day("2026-10-07", 48), // $2/h
  day("2026-10-08", 0), // quiet: excluded from the baseline
  day("2026-10-09", 48),
  day("2026-10-10", 72), // $3/h
  day("2026-10-12", 48),
  day("2026-10-14", 999), // after stableThrough: not sealed, excluded
];

describe("computeSpendTempo", () => {
  it("compares today's cost per elapsed hour with the median sealed hourly rate", () => {
    const tempo = computeSpendTempo([...history, day("2026-10-15", 48)], meta, NOON);
    expect(tempo.typicalPerHour).toBe(2);
    expect(tempo.todayPerHour).toBe(4);
    expect(tempo.ratio).toBe(2);
    expect(tempo.tempo).toBeCloseTo(Math.SQRT2, 6);
    expect(tempo.neutral).toBe(false);
  });

  it("clamps extreme ratios", () => {
    expect(computeSpendTempo([...history, day("2026-10-15", 10_000)], meta, NOON).ratio).toBe(4);
    expect(computeSpendTempo(history, meta, NOON).ratio).toBe(0.25);
  });

  it("stays neutral without enough sealed history", () => {
    const tempo = computeSpendTempo(history.slice(0, 3), meta, NOON);
    expect(tempo).toMatchObject({ neutral: true, tempo: 1, ratio: 1, typicalPerHour: null });
    expect(computeSpendTempo(history, { ...meta, stableThrough: null }, NOON).neutral).toBe(true);
  });

  it("floors elapsed time at one hour just after midnight", () => {
    const early = new Date(2026, 9, 15, 0, 6, 0).getTime();
    expect(computeSpendTempo([...history, day("2026-10-15", 2)], meta, early).todayPerHour).toBe(2);
  });
});
