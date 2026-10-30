/**
 * @sriinnu/tokmeter-core — Busiest time of day.
 *
 * Splits the last 30 sealed days' cost into eight 3-hour local-time blocks
 * (00–03 … 21–24) and names the block that carried the most of it. Read
 * straight off the sealed relay curves (`DailyAggregate.costByHour`); no raw
 * history is re-parsed.
 *
 * The ledger stores COST per hour, not tokens, so every number here is a
 * share of cost. It is an estimate exactly as far as the underlying day costs
 * are estimates.
 */

import type { DailyAggregate } from "./aggregates.js";
import { localDateKey } from "./date-utils.js";
import type { TimeOfDayProfile } from "./types.js";

/** Calendar days before today that feed the profile. */
export const TIME_OF_DAY_WINDOW_DAYS = 30;

/** Fewer curved days than this and the split is noise, not a habit. */
export const TIME_OF_DAY_MIN_DAYS = 7;

const BLOCK_HOURS = 3;
const BLOCK_COUNT = 24 / BLOCK_HOURS;

/**
 * A curve is trusted only when its 24 slots add up to the day's own cost. A
 * day sealed before `costByHour` existed that later took a straggler fold has
 * a curve seeded from just those stragglers (see `foldCostByHour`): its shape
 * would be wrong, so it is skipped like a day with no curve at all.
 */
function curveReconciles(day: DailyAggregate, curveTotal: number): boolean {
  const tolerance = Math.max(0.01, Math.abs(day.cost) * 0.001);
  return Math.abs(curveTotal - day.cost) <= tolerance;
}

function isValidCurve(curve: unknown): curve is number[] {
  return (
    Array.isArray(curve) &&
    curve.length === 24 &&
    curve.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0)
  );
}

/**
 * Share of cost per 3-hour block over the `TIME_OF_DAY_WINDOW_DAYS` local
 * calendar days before `now`'s day. Today is always excluded (it is still
 * moving). Days without a usable curve are skipped and counted in
 * `daysSkipped`, never treated as $0. Days with a curve but no spend add
 * nothing and are not counted as feeding the profile.
 */
export function computeTimeOfDayProfile(
  aggregates: readonly DailyAggregate[],
  now: number
): TimeOfDayProfile {
  const nowDate = new Date(now);
  const todayKey = localDateKey(now);
  // Local-midday anchor so a DST shift can never move the window edge a day.
  const windowStartKey = localDateKey(
    new Date(
      nowDate.getFullYear(),
      nowDate.getMonth(),
      nowDate.getDate() - TIME_OF_DAY_WINDOW_DAYS,
      12
    ).getTime()
  );

  const blockCost = new Array<number>(BLOCK_COUNT).fill(0);
  let daysCounted = 0;
  let daysSkipped = 0;
  const seen = new Set<string>();
  for (const day of aggregates) {
    if (day.date >= todayKey || day.date < windowStartKey) continue;
    if (seen.has(day.date)) continue;
    seen.add(day.date);
    const curve = day.costByHour;
    if (!isValidCurve(curve)) {
      daysSkipped++;
      continue;
    }
    const curveTotal = curve.reduce((a, b) => a + b, 0);
    if (!curveReconciles(day, curveTotal)) {
      daysSkipped++;
      continue;
    }
    if (curveTotal <= 0) continue;
    daysCounted++;
    for (let h = 0; h < 24; h++) blockCost[Math.floor(h / BLOCK_HOURS)] += curve[h];
  }

  const totalCost = blockCost.reduce((a, b) => a + b, 0);
  const base = {
    windowDays: TIME_OF_DAY_WINDOW_DAYS,
    minDays: TIME_OF_DAY_MIN_DAYS,
    daysCounted,
    daysSkipped,
  };
  if (daysCounted < TIME_OF_DAY_MIN_DAYS || totalCost <= 0) {
    return { ...base, status: "insufficient", totalCost: 0, blocks: [], peak: null };
  }

  const blocks = blockCost.map((cost, i) => ({
    startHour: i * BLOCK_HOURS,
    endHour: (i + 1) * BLOCK_HOURS,
    cost,
    share: cost / totalCost,
  }));
  // Strictly greater: on an exact tie the earlier block wins, deterministically.
  let peak = blocks[0];
  for (const b of blocks) if (b.cost > peak.cost) peak = b;
  return { ...base, status: "ok", totalCost, blocks, peak };
}
