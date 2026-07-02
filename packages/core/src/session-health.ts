/**
 * @sriinnu/tokmeter-core — Session health band.
 *
 * The universal, UI-agnostic definition of "how close to a cliff is this
 * signal": a 0–100% (or value-vs-budget) reading maps to a semantic band.
 * Consumers own the presentation — the statusline maps a band to an ANSI
 * color, the macOS bar to a SwiftUI Color — but they share THIS definition so
 * green/yellow/orange/red always mean the same thresholds everywhere.
 *
 * Provider-agnostic by construction: the engine takes a percentage, not a
 * provider. A signal a given provider cannot produce (e.g. context-window fill
 * for an agent that never exposes a context size) simply contributes no band,
 * rather than a fabricated one — see {@link worstBand}, which ignores absent
 * readings. This keeps the feature universal (cost/budget works for every
 * provider) while letting richer signals light up where a provider supports
 * them, and never hallucinates a number.
 */

/** Semantic health bands, ascending in severity. */
export type HealthBand = "ok" | "warn" | "high" | "critical";

/** Severity order — index is the rank used by {@link worstBand}. */
const BAND_ORDER: readonly HealthBand[] = ["ok", "warn", "high", "critical"];

/**
 * Lower inclusive bounds (in percent) for each escalating band. A reading
 * `>= critical` is critical, `>= high` is high, `>= warn` is warn, else ok.
 */
export interface HealthThresholds {
  warn: number;
  high: number;
  critical: number;
}

export const DEFAULT_HEALTH_THRESHOLDS: HealthThresholds = {
  warn: 50,
  high: 75,
  critical: 90,
};

/**
 * Map a percentage (0–100+, values above 100 stay critical) to a band.
 * A non-finite or negative reading is treated as `ok` — an unknown signal is
 * never alarming.
 */
export function bandForPct(pct: number, t: HealthThresholds = DEFAULT_HEALTH_THRESHOLDS): HealthBand {
  if (!Number.isFinite(pct) || pct < 0) return "ok";
  if (pct >= t.critical) return "critical";
  if (pct >= t.high) return "high";
  if (pct >= t.warn) return "warn";
  return "ok";
}

/**
 * Percent of a budget/cap that `value` represents, or null when the budget is
 * missing/invalid (so the caller shows no band rather than a bogus one). Used
 * by the universal cost/budget signal.
 */
export function pctOfBudget(value: number, budget: number): number | null {
  if (!Number.isFinite(value) || !Number.isFinite(budget) || budget <= 0) return null;
  return (value / budget) * 100;
}

/**
 * The worst (highest-severity) band across readings — the "worst session
 * wins" rule. Absent readings (`null`/`undefined`) are ignored, so a session
 * that can't produce the selected signal doesn't drag the result to `ok` nor
 * fabricate a value. Returns null when there is nothing to report.
 */
export function worstBand(bands: Array<HealthBand | null | undefined>): HealthBand | null {
  let worstRank = -1;
  for (const b of bands) {
    if (!b) continue;
    const rank = BAND_ORDER.indexOf(b);
    if (rank > worstRank) worstRank = rank;
  }
  return worstRank < 0 ? null : BAND_ORDER[worstRank];
}
