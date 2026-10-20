/**
 * @sriinnu/tokmeter-core — The prices each sealed day was billed at.
 *
 * A day's cost is fixed when it seals, at that day's kosha rates. kosha keeps
 * no price history: `~/.kosha/registry.json` is overwritten on every refresh.
 * So a rebuild of a sealed day (Deep Rescan, a repair after a parser fix) used
 * to reprice its records at TODAY's rates, and a day could change cost without
 * a single token changing. Each sealed day now carries the card every model
 * was billed with, and a rebuild bills that day's calculated records with its
 * own cards. Tool-reported ("direct") costs are never repriced either way.
 *
 * Days sealed before cards existed get an "implied" card on rebuild: today's
 * card scaled so the day's sealed token mix costs exactly what was sealed —
 * the day's own price level, which keeps an unchanged day at its frozen cost
 * and bills a grown one at the same level. It is approximate when a tool
 * reported part of that model's cost itself (the sealed figure then mixes
 * reported and calculated cost), and is labelled "implied" wherever shown.
 *
 * A card is ~100 bytes and only models used that day get one, so storing them
 * costs about 1–2 KB per day.
 */

import type { DailyAggregate } from "./aggregates.js";
import {
  costFromCard,
  type PriceCard,
  type PricingService,
  type PricingSourceTier,
} from "./pricing.js";
import type { TokenRecord } from "./types.js";

export interface DayPrice {
  /** Per-million rates the day's calculated cost used for this model. */
  card: PriceCard;
  /**
   * Where the card came from: the pricing tier that resolved it when the day
   * was priced, or "implied" for a card derived from a day sealed without one.
   */
  source: PricingSourceTier | "implied";
  /** The registry id the card was taken from, when it differs from the model id. */
  matchedId?: string;
}

/** Keyed by raw model id, like `DailyAggregate.models`. */
export type DayPrices = Record<string, DayPrice>;

/** The subset of PricingService this module needs (lets tests pass a fake). */
export type CardSource = Pick<PricingService, "getPricingWithSource">;

const RATE_FIELDS = [
  "inputPerMillion",
  "outputPerMillion",
  "cacheReadPerMillion",
  "cacheWritePerMillion",
  "cacheWrite1hPerMillion",
  "reasoningInputPerMillion",
  "reasoningOutputPerMillion",
] as const satisfies readonly (keyof PriceCard)[];

/** Only the rates billing reads — kosha entries carry batch rates and more. */
function billingCard(p: PriceCard, scale = 1): PriceCard {
  const out = { inputPerMillion: 0, outputPerMillion: 0 } as PriceCard;
  for (const k of RATE_FIELDS) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v * scale;
  }
  return out;
}

/** Today's cards for `models`. Unpriced models get none: there is no price to keep. */
export async function priceCardsFor(
  models: Iterable<string>,
  pricing: CardSource
): Promise<DayPrices> {
  const out: DayPrices = {};
  for (const model of models) {
    const { pricing: card, source } = await pricing.getPricingWithSource(model);
    if (!card) continue;
    out[model] = {
      card: billingCard(card),
      source: source.tier,
      ...(source.matchedId ? { matchedId: source.matchedId } : {}),
    };
  }
  return out;
}

/**
 * Cards for a day sealed before cards were stored: today's card scaled by
 * sealedCost ÷ todayCost(sealed tokens), per model. A model sealed at $0 or
 * unpriced today gets none — its records then price at today's rate, and the
 * no-shrink guard keeps the sealed cost if that comes out lower.
 */
export async function impliedPrices(day: DailyAggregate, pricing: CardSource): Promise<DayPrices> {
  const out: DayPrices = {};
  for (const [model, b] of Object.entries(day.models)) {
    if (!(b.cost > 0)) continue;
    const { pricing: card } = await pricing.getPricingWithSource(model);
    if (!card) continue;
    const base = costFromCard(
      model,
      card,
      b.inputTokens,
      b.outputTokens,
      b.cacheReadTokens,
      b.cacheWriteTokens,
      b.reasoningTokens,
      b.cacheWrite1hTokens ?? 0
    );
    if (!(base > 0)) continue;
    out[model] = { card: billingCard(card, b.cost / base), source: "implied" };
  }
  return out;
}

/** The cards a rebuild of `existing` must bill with: its own, or implied ones. */
export async function pricesForRebuild(
  existing: DailyAggregate,
  pricing: CardSource
): Promise<DayPrices> {
  return existing.prices ?? impliedPrices(existing, pricing);
}

/** Bill a record with a stored card instead of today's kosha rate. */
export function priceWithCard(r: TokenRecord, card: PriceCard): void {
  r.cost = costFromCard(
    r.model,
    card,
    r.inputTokens,
    r.outputTokens,
    r.cacheReadTokens,
    r.cacheWriteTokens,
    r.reasoningTokens,
    r.cacheWrite1hTokens ?? 0
  );
  if (r.usage) r.usage.cost = "calculated";
}

/**
 * Set `day.prices` before the day is written: `kept` cards for models that
 * already had one (a rebuilt day keeps its own), today's cards for the rest.
 */
export async function attachDayPrices(
  day: DailyAggregate,
  pricing: CardSource,
  kept?: DayPrices
): Promise<void> {
  const models = Object.keys(day.models);
  const fresh = await priceCardsFor(
    models.filter((m) => !kept?.[m]),
    pricing
  );
  const prices: DayPrices = {};
  for (const m of models) {
    const p = kept?.[m] ?? fresh[m];
    if (p) prices[m] = p;
  }
  if (Object.keys(prices).length > 0) day.prices = prices;
  else delete day.prices;
}
