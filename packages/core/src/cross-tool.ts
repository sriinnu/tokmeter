/**
 * @sriinnu/tokmeter-core — Cross-tool token-shape projection.
 *
 * Projects today's exact token shape against the user's top lifetime
 * models. Surfaces "if all of today's tokens had run on model X instead,
 * you'd have spent $Y" — the kind of comparison nobody else ships because
 * most trackers don't have a unified pricing oracle.
 *
 * Universal-first: no hardcoded model list; the projection uses the user's
 * actual top lineup, so the alternatives reflect what they'd realistically pick.
 */

import type { DailyAggregate } from "./aggregates.js";
import type { PricingService } from "./pricing.js";
import type { ModelSummary, ProviderId } from "./types.js";

export interface CrossToolComparison {
  todayActualCost: number;
  todayTokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
  };
  projections: Array<{
    model: string;
    provider: ProviderId;
    projectedCost: number;
  }>;
}

export async function computeCrossToolComparison(
  pricing: PricingService,
  today: DailyAggregate | null,
  topModels: ModelSummary[]
): Promise<CrossToolComparison> {
  const totals = {
    input: today?.inputTokens ?? 0,
    output: today?.outputTokens ?? 0,
    cacheRead: today?.cacheReadTokens ?? 0,
    cacheWrite: today?.cacheWriteTokens ?? 0,
    reasoning: today?.reasoningTokens ?? 0,
  };
  const projections = await Promise.all(
    topModels.map(async (m) => ({
      model: m.model,
      provider: m.provider,
      projectedCost: await pricing.calculateCost(
        m.model,
        totals.input,
        totals.output,
        totals.cacheRead,
        totals.cacheWrite,
        totals.reasoning
      ),
    }))
  );
  projections.sort((a, b) => a.projectedCost - b.projectedCost);
  return {
    todayActualCost: today?.cost ?? 0,
    todayTokens: totals,
    projections,
  };
}
