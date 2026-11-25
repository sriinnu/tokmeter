/**
 * High-water daily & lifetime floors for the daemon HTTP API.
 *
 * Within a single local calendar day, spend/tokens are monotonic upward so
 * parser-side fork-dedup swaps cannot make "today" or lifetime totals dip.
 */

import { localDateKey, nullMap, type TokmeterCore } from "@sriinnu/tokmeter";

export interface TodayTotals {
  cost: number;
  in: number;
  out: number;
  projects: Record<string, { cost: number; in: number; out: number }>;
  day: string;
}

/**
 * Per-day high-water marks for "today" — today's cost MUST be monotonic
 * upward within a day (you cannot un-spend money), but the codex parser's
 * fork-dedup ("latest mtime sibling wins") can swap winners as new sibling
 * rollouts appear, momentarily showing a SMALLER today total than the prior
 * scan. That's parser flux, not a real refund. The floor pins each field to
 * the high-water mark observed during the current local day so the displayed
 * "today" only ever grows. Resets automatically on day rollover (when
 * `localDateKey()` changes).
 */
let _todayHighWater: TodayTotals | null = null;

/**
 * Lifetime-cost high-water for `/api/stats` and `/api/quick`.
 */
export interface StatsFloor {
  day: string;
  totalCost: number;
  totalTokens: number;
}
let _statsHighWater: StatsFloor | null = null;

/**
 * Pure high-water merge, split out from {@link applyTodayFloor} so the
 * monotonicity math is testable without the module-level `_todayHighWater`
 * singleton. `prior === null` (or a stale day) resets the floor to `computed`
 * as-is; otherwise every field — including each project's own cost/in/out —
 * is pinned to its own running max.
 */
export function computeTodayFloor(computed: TodayTotals, prior: TodayTotals | null): TodayTotals {
  // Day rollover (or first call) — reset the floor and accept what we see.
  if (!prior || prior.day !== computed.day) {
    return {
      cost: computed.cost,
      in: computed.in,
      out: computed.out,
      day: computed.day,
      projects: { ...computed.projects },
    };
  }

  const dropped = computed.cost + 0.005 < prior.cost;
  if (dropped) {
    console.warn(
      `[today-floor] computed today $${computed.cost.toFixed(2)} < high-water $${prior.cost.toFixed(2)} — keeping high-water (likely codex fork-dedup winner swap; data not lost, just a parser-side reweighting).`
    );
  }

  const allKeys = new Set([...Object.keys(computed.projects), ...Object.keys(prior.projects)]);
  // Null prototype: a project literally named "__proto__" stays a key.
  const projects = nullMap<{ cost: number; in: number; out: number }>();
  for (const k of allKeys) {
    const a = computed.projects[k] ?? { cost: 0, in: 0, out: 0 };
    const b = prior.projects[k] ?? { cost: 0, in: 0, out: 0 };
    projects[k] = {
      cost: Math.max(a.cost, b.cost),
      in: Math.max(a.in, b.in),
      out: Math.max(a.out, b.out),
    };
  }

  return {
    cost: Math.max(computed.cost, prior.cost),
    in: Math.max(computed.in, prior.in),
    out: Math.max(computed.out, prior.out),
    day: computed.day,
    projects,
  };
}

export function applyTodayFloor(computed: TodayTotals): TodayTotals {
  _todayHighWater = computeTodayFloor(computed, _todayHighWater);
  return _todayHighWater;
}

/**
 * Pure high-water merge for lifetime `totalCost` and `totalTokens` within `day`.
 */
export function computeStatsFloor<T extends { totalCost?: number; totalTokens?: number }>(
  stats: T,
  prior: StatsFloor | null,
  day: string
): { result: T; floor: StatsFloor | null } {
  if (!stats || typeof stats.totalCost !== "number" || typeof stats.totalTokens !== "number") {
    return { result: stats, floor: prior };
  }
  if (!prior || prior.day !== day) {
    return {
      result: stats,
      floor: { day, totalCost: stats.totalCost, totalTokens: stats.totalTokens },
    };
  }
  if (stats.totalCost + 0.005 < prior.totalCost) {
    console.warn(
      `[stats-floor] lifetime $${stats.totalCost.toFixed(2)} < high-water $${prior.totalCost.toFixed(2)} — keeping high-water (matches today-floor; almost certainly a codex fork-dedup winner swap).`
    );
  }
  const totalCost = Math.max(stats.totalCost, prior.totalCost);
  const totalTokens = Math.max(stats.totalTokens, prior.totalTokens);
  return { result: { ...stats, totalCost, totalTokens }, floor: { day, totalCost, totalTokens } };
}

export function applyStatsFloor<T extends { totalCost?: number; totalTokens?: number }>(
  stats: T
): T {
  const { result, floor } = computeStatsFloor(stats, _statsHighWater, localDateKey());
  _statsHighWater = floor;
  return result;
}

export function computeTodayTotals(core: TokmeterCore): TodayTotals {
  return todayTotalsFrom(core.getTodayAggregate?.() ?? null, localDateKey());
}

/**
 * Today's totals for `day` from the core's today aggregate. An aggregate for
 * another day counts as nothing yet for `day`.
 */
export function todayTotalsFrom(
  today: {
    date?: string;
    cost: number;
    inputTokens: number;
    outputTokens: number;
    projects: Record<string, { cost: number; inputTokens: number; outputTokens: number }>;
  } | null,
  day: string
): TodayTotals {
  // Null prototype: a project literally named "__proto__" stays a key.
  const projects = nullMap<{ cost: number; in: number; out: number }>();
  if (today && (today.date === undefined || today.date === day)) {
    for (const [name, pb] of Object.entries(today.projects)) {
      projects[name || "unknown"] = {
        cost: pb.cost,
        in: pb.inputTokens,
        out: pb.outputTokens,
      };
    }
    return { cost: today.cost, in: today.inputTokens, out: today.outputTokens, projects, day };
  }
  return { cost: 0, in: 0, out: 0, projects, day };
}
