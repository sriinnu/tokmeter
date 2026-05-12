/**
 * @sriinnu/tokmeter-core — Statbar signals.
 *
 * Derived metrics for "how am I doing right now" — burn rate, cache health,
 * pace vs. typical, compaction tax, and the live session pointer. Computed
 * from the same TokenRecord[] that drives every other view, but referenced
 * against an explicit `now` so tests can pin time.
 */

import { localDateKey } from "./date-utils.js";
import type { StatbarSignals, TokenRecord } from "./types.js";

/** How long we look back when computing burn rate. */
const BURN_WINDOW_MINUTES = 60;

/** A record younger than this counts as "live" for the live-session pill. */
const LIVE_FRESHNESS_SECONDS = 5 * 60;

/** How many past active days inform the pace baseline. */
const PACE_BASELINE_DAYS = 7;

/** Total token count helper — keep parity with aggregator's sumTokens. */
function recordTotal(r: TokenRecord): number {
  return (
    r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens
  );
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Build the full StatbarSignals payload from a record set. The `records`
 * array can be in any order — we don't mutate it. `now` is in epoch ms.
 */
export function computeStatbarSignals(records: TokenRecord[], now: number): StatbarSignals {
  // ── Burn rate ──────────────────────────────────────────────────────────
  const burnWindowMs = BURN_WINDOW_MINUTES * 60_000;
  const burnSince = now - burnWindowMs;
  let burnCost = 0;
  let burnTokens = 0;
  let burnRecords = 0;
  for (const r of records) {
    if (r.timestamp < burnSince || r.timestamp > now) continue;
    burnCost += r.cost;
    burnTokens += recordTotal(r);
    burnRecords++;
  }
  // Scale to per-hour. Window is exactly 60 min so this is just the raw sum,
  // but keeping the multiplier explicit so changing BURN_WINDOW_MINUTES still
  // gives sensible numbers.
  const hoursInWindow = BURN_WINDOW_MINUTES / 60;
  const burnRate = {
    costPerHour: hoursInWindow > 0 ? burnCost / hoursInWindow : 0,
    tokensPerHour: hoursInWindow > 0 ? burnTokens / hoursInWindow : 0,
    windowMinutes: BURN_WINDOW_MINUTES,
    recordsInWindow: burnRecords,
  };

  // ── Today's slice (shared by cache-hit, pace, compaction) ──────────────
  const todayKey = localDateKey(now);
  const todayRecords: TokenRecord[] = [];
  for (const r of records) {
    if (localDateKey(r.timestamp) === todayKey && r.timestamp <= now) {
      todayRecords.push(r);
    }
  }

  // ── Cache hit today ────────────────────────────────────────────────────
  let todayCacheRead = 0;
  let todayInput = 0;
  let todayCost = 0;
  for (const r of todayRecords) {
    todayCacheRead += r.cacheReadTokens;
    todayInput += r.inputTokens;
    todayCost += r.cost;
  }
  const cacheDenominator = todayCacheRead + todayInput;
  const cacheHitToday = {
    rate: cacheDenominator > 0 ? todayCacheRead / cacheDenominator : 0,
    cacheReadTokens: todayCacheRead,
    inputTokens: todayInput,
  };

  // ── Pace vs. typical ───────────────────────────────────────────────────
  // For each past day with any records, sum cost from midnight to the same
  // wall-clock hour:minute as `now`. Median those — that's "typical by this
  // hour." Compare to today's actual.
  const nowDate = new Date(now);
  const minutesIntoToday = nowDate.getHours() * 60 + nowDate.getMinutes();

  // Group past records by day, but only those that fall within the same
  // minute-of-day window. Skip today.
  const pastByDay = new Map<string, number>();
  for (const r of records) {
    const key = localDateKey(r.timestamp);
    if (key === todayKey) continue;
    const d = new Date(r.timestamp);
    const minute = d.getHours() * 60 + d.getMinutes();
    if (minute > minutesIntoToday) continue;
    pastByDay.set(key, (pastByDay.get(key) ?? 0) + r.cost);
  }
  // Use the most recent N active days only — older data drifts away from
  // current workflow patterns and stops being predictive.
  const recentDayCosts = [...pastByDay.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .slice(0, PACE_BASELINE_DAYS)
    .map(([, v]) => v);
  const typicalByNow = median(recentDayCosts);
  let actualByNow = 0;
  for (const r of todayRecords) actualByNow += r.cost;
  const paceMultiple =
    typicalByNow > 0.0001 && recentDayCosts.length > 0 ? actualByNow / typicalByNow : null;
  const pace = {
    multiple: paceMultiple,
    typicalCostByNow: typicalByNow,
    actualCostByNow: actualByNow,
    daysOfHistory: recentDayCosts.length,
  };

  // ── Compaction tax (today) ─────────────────────────────────────────────
  let compactionCost = 0;
  let compactionTokens = 0;
  let compactionEvents = 0;
  for (const r of todayRecords) {
    if (r.kind !== "compaction") continue;
    compactionCost += r.cost;
    compactionTokens += recordTotal(r);
    compactionEvents++;
  }
  const compactionToday = {
    cost: compactionCost,
    tokens: compactionTokens,
    share: todayCost > 0.0001 ? compactionCost / todayCost : 0,
    events: compactionEvents,
  };

  // ── Live session ───────────────────────────────────────────────────────
  // The most recent record across the whole record set. If it's within the
  // freshness window, expose it as the "live" pointer; otherwise null.
  let mostRecent: TokenRecord | null = null;
  for (const r of records) {
    if (r.timestamp > now) continue; // ignore future timestamps (clock skew)
    if (!mostRecent || r.timestamp > mostRecent.timestamp) {
      mostRecent = r;
    }
  }
  let liveSession: StatbarSignals["liveSession"] = null;
  if (mostRecent) {
    const ageSeconds = Math.max(0, Math.floor((now - mostRecent.timestamp) / 1000));
    if (ageSeconds <= LIVE_FRESHNESS_SECONDS) {
      liveSession = {
        provider: mostRecent.provider,
        model: mostRecent.model,
        project: mostRecent.project,
        ageSeconds,
        lastRecordCost: mostRecent.cost,
      };
    }
  }

  return {
    burnRate,
    cacheHitToday,
    pace,
    compactionToday,
    liveSession,
  };
}
