import type { TokmeterScanMeta } from "../hooks/useTokmeterData.js";

/**
 * How much a day's numbers can still move.
 *
 * - `sealed`: on or before `meta.stableThrough`. The relay ledger is immutable
 *   for these days; a rescan may only ever grow them.
 * - `live`: today, while the summary's today-state is live.
 * - `snapshot`: today, but the live refresh is degraded or unavailable, so the
 *   number is whatever the last good scan saw.
 * - `pending`: a past day the summary has not sealed yet (e.g. yesterday just
 *   after midnight, or history still warming up).
 */
export type DayState = "sealed" | "live" | "snapshot" | "pending";

export function getDayState(date: string, todayKey: string, meta: TokmeterScanMeta): DayState {
  if (date === todayKey) return meta.todayState === "live" ? "live" : "snapshot";
  if (meta.stableThrough && date <= meta.stableThrough) return "sealed";
  return "pending";
}

export const DAY_STATE_LABEL: Record<DayState, string> = {
  sealed: "Sealed",
  live: "Live",
  snapshot: "Snapshot",
  pending: "Not sealed yet",
};
