import type { TokmeterDailyEntry, TokmeterScanMeta } from "../hooks/useTokmeterData.js";
import { localDateKey } from "./dates.js";

/** Below this many sealed active days there is no "typical" to compare with. */
export const MIN_BASELINE_DAYS = 5;
const BASELINE_DAYS = 30;
const MIN_RATIO = 0.25;
const MAX_RATIO = 4;

export interface SpendTempo {
  /** today's rate ÷ typical rate, clamped; 1 when neutral. */
  ratio: number;
  /** Animation speed multiplier derived from the ratio (log-scaled). */
  tempo: number;
  /** Brightness multiplier derived from the ratio. */
  brightness: number;
  neutral: boolean;
  todayPerHour: number | null;
  typicalPerHour: number | null;
}

const NEUTRAL: Omit<SpendTempo, "todayPerHour" | "typicalPerHour"> = {
  ratio: 1,
  tempo: 1,
  brightness: 1,
  neutral: true,
};

/**
 * Decoration driven by data, never a new number on the page: compares
 * today's estimated cost per elapsed wall-clock hour with the median hourly
 * rate (cost ÷ 24) of the last 30 sealed days that have a ledger entry.
 *
 * Both rates are per wall-clock hour, so they are comparable. Quiet days are
 * left out of the baseline — with them, a part-time user's median would be $0
 * and every working day would read as an infinite spike. Elapsed time is
 * floored at one hour so the first minutes after midnight don't explode.
 */
export function computeSpendTempo(
  daily: TokmeterDailyEntry[],
  meta: TokmeterScanMeta,
  now: number = Date.now()
): SpendTempo {
  const todayKey = localDateKey(now);
  const sealedThrough = meta.stableThrough;
  if (!sealedThrough) return { ...NEUTRAL, todayPerHour: null, typicalPerHour: null };

  const baseline = daily
    .filter((d) => d.date <= sealedThrough && d.date < todayKey && d.cost > 0)
    .slice(-BASELINE_DAYS)
    .map((d) => d.cost / 24)
    .sort((a, b) => a - b);
  const today = daily.find((d) => d.date === todayKey);
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const elapsedHours = Math.max(1, (now - midnight.getTime()) / 3_600_000);
  const todayPerHour = (today?.cost ?? 0) / elapsedHours;

  if (baseline.length < MIN_BASELINE_DAYS) {
    return { ...NEUTRAL, todayPerHour, typicalPerHour: null };
  }
  const mid = Math.floor(baseline.length / 2);
  const typicalPerHour =
    baseline.length % 2 ? baseline[mid] : (baseline[mid - 1] + baseline[mid]) / 2;
  if (!(typicalPerHour > 0)) return { ...NEUTRAL, todayPerHour, typicalPerHour };

  const ratio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, todayPerHour / typicalPerHour));
  const octaves = Math.log2(ratio); // -2 … +2
  return {
    ratio,
    tempo: 2 ** (octaves * 0.5), // 0.5× … 2×
    brightness: 1 + octaves * 0.08, // 0.84 … 1.16
    neutral: false,
    todayPerHour,
    typicalPerHour,
  };
}
