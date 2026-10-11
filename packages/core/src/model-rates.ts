/**
 * Per-model rate card: the $/M list rates tokmeter bills each model with,
 * where each rate came from, and today's effective $/M beside them.
 *
 * Transparency rules:
 * - A rate is reported exactly as `calculateCost` uses it. When the registry
 *   doesn't carry a field and billing falls back to a documented ratio, the
 *   rate is still shown, flagged `derived`, with the rule in `basis`.
 * - A rate billing never uses is `null`, not 0 (cache writes on a model with
 *   no cache-write price are not charged).
 * - An unpriced model reports every rate as `null` and tier "unpriced". No
 *   price is ever invented.
 */

import type { PricingService, PricingSource } from "./pricing.js";
import type { ModelSummary, ProviderId } from "./types.js";

export interface Rate {
  /** USD per million tokens, or null when billing doesn't charge this bucket. */
  perMillion: number | null;
  /** True when the registry lacks the field and billing uses a fallback rule. */
  derived: boolean;
  /** The fallback rule, when derived (e.g. "10% of input"). */
  basis?: string;
}

export interface ModelRateCard {
  model: string;
  provider: ProviderId;
  source: PricingSource;
  rates: {
    input: Rate;
    output: Rate;
    cacheRead: Rate;
    /** 5-minute-TTL cache write. */
    cacheWrite: Rate;
    /** 1-hour-TTL cache write. */
    cacheWrite1h: Rate;
    /** Reasoning/thinking tokens. */
    reasoning: Rate;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    cost: number;
  };
  /** cost ÷ total tokens × 1M, or null when there were no tokens. Includes
   *  any tool-reported cost folded into this model's total. */
  effectivePerMillion: number | null;
}

export interface ModelRatesResponse {
  scope: "today" | "all";
  /** mtime (ms) of the kosha registry the rates were read from; 0 if absent. */
  registryMtime: number;
  /** True when kosha failed to load (every model then comes from overrides,
   *  the manifest, or is unpriced). */
  pricingUnavailable: boolean;
  models: ModelRateCard[];
}

const exact = (perMillion: number): Rate => ({ perMillion, derived: false });
const none: Rate = { perMillion: null, derived: false };

export async function computeModelRates(
  pricing: PricingService,
  models: ModelSummary[],
  scope: "today" | "all"
): Promise<ModelRatesResponse> {
  const cards: ModelRateCard[] = [];
  for (const m of models) {
    const { pricing: p, source } = await pricing.getPricingWithSource(m.model);
    // Token counts are whole numbers. A model aggregated across providers
    // (or rebuilt from the cost fallback) can carry a fractional count; a
    // strict client decode then rejects the whole response, so round here.
    const whole = (n: number): number => (Number.isFinite(n) ? Math.round(n) : 0);
    const usage = {
      inputTokens: whole(m.inputTokens),
      outputTokens: whole(m.outputTokens),
      cacheReadTokens: whole(m.cacheReadTokens),
      cacheWriteTokens: whole(m.cacheWriteTokens),
      reasoningTokens: whole(m.reasoningTokens),
      totalTokens: whole(m.totalTokens),
      cost: m.cost,
    };
    const effectivePerMillion =
      usage.totalTokens > 0 ? (m.cost / usage.totalTokens) * 1_000_000 : null;

    if (!p) {
      cards.push({
        model: m.model,
        provider: m.provider,
        source,
        rates: {
          input: none,
          output: none,
          cacheRead: none,
          cacheWrite: none,
          cacheWrite1h: none,
          reasoning: none,
        },
        usage,
        effectivePerMillion,
      });
      continue;
    }

    // Mirrors PricingService.calculateCost branch for branch.
    const cacheRead: Rate =
      p.cacheReadPerMillion !== undefined
        ? exact(p.cacheReadPerMillion)
        : { perMillion: p.inputPerMillion * 0.1, derived: true, basis: "10% of input" };

    const charged5m = !!p.cacheWritePerMillion;
    const cacheWrite: Rate = charged5m ? exact(p.cacheWritePerMillion as number) : none;

    let cacheWrite1h: Rate;
    if (p.cacheWrite1hPerMillion) {
      cacheWrite1h = exact(p.cacheWrite1hPerMillion);
    } else if (!p.cacheWritePerMillion) {
      // calculateCost only bills writes when a 5m or 1h rate exists.
      cacheWrite1h = none;
    } else if (/claude/i.test(m.model)) {
      cacheWrite1h = { perMillion: p.inputPerMillion * 2, derived: true, basis: "2× input" };
    } else {
      cacheWrite1h = {
        perMillion: p.cacheWritePerMillion,
        derived: true,
        basis: "same as 5m write",
      };
    }

    const reasoning: Rate =
      p.reasoningOutputPerMillion !== undefined
        ? exact(p.reasoningOutputPerMillion)
        : p.reasoningInputPerMillion !== undefined
          ? exact(p.reasoningInputPerMillion)
          : { perMillion: p.outputPerMillion, derived: true, basis: "output rate" };

    cards.push({
      model: m.model,
      provider: m.provider,
      source,
      rates: {
        input: exact(p.inputPerMillion),
        output: exact(p.outputPerMillion),
        cacheRead,
        cacheWrite,
        cacheWrite1h,
        reasoning,
      },
      usage,
      effectivePerMillion,
    });
  }
  return {
    scope,
    registryMtime: pricing.getRegistryMtime(),
    pricingUnavailable: pricing.pricingUnavailable,
    models: cards,
  };
}
