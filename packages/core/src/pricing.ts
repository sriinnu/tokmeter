/**
 * @tokmeter/core — Pricing bridge using @sriinnu/kosha-discovery.
 *
 * Resolves model pricing via the user's existing kosha-discovery package.
 */

import type { ModelPricing } from "@sriinnu/kosha-discovery";

/** Cached pricing lookup table: modelId → pricing. */
export class PricingService {
  private cache = new Map<string, ModelPricing | null>();
  private kosha: any = null;
  private initialized = false;
  private cacheDir?: string;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir;
  }

  /** Initialize the kosha-discovery registry. */
  async init(): Promise<void> {
    if (this.initialized) return;
    try {
      const { createKosha } = await import("@sriinnu/kosha-discovery");
      this.kosha = await createKosha();
    } catch {
      // kosha-discovery not available — pricing will be unavailable
      this.kosha = null;
    }
    this.initialized = true;
  }

  /** Get pricing for a model. Returns null if not found. */
  async getPricing(modelId: string): Promise<ModelPricing | null> {
    if (this.cache.has(modelId)) return this.cache.get(modelId) ?? null;

    if (!this.kosha) {
      this.cache.set(modelId, null);
      return null;
    }

    try {
      const card = await this.kosha.model(modelId);
      if (card?.pricing) {
        this.cache.set(modelId, card.pricing);
        return card.pricing;
      }
    } catch {
      // model not found
    }

    this.cache.set(modelId, null);
    return null;
  }

  /** Calculate cost for a given token usage. */
  async calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    reasoningTokens = 0,
  ): Promise<number> {
    const pricing = await this.getPricing(modelId);
    if (!pricing) return 0;

    const perToken = (perMillion: number) => perMillion / 1_000_000;

    let cost = 0;
    cost += inputTokens * perToken(pricing.inputPerMillion);
    cost += outputTokens * perToken(pricing.outputPerMillion);
    if (pricing.cacheReadPerMillion && cacheReadTokens) {
      cost += cacheReadTokens * perToken(pricing.cacheReadPerMillion);
    }
    if (pricing.cacheWritePerMillion && cacheWriteTokens) {
      cost += cacheWriteTokens * perToken(pricing.cacheWritePerMillion);
    }
    // Use dedicated reasoning pricing if available, otherwise bill as output tokens
    if (reasoningTokens) {
      const reasoningPerMillion = (pricing as Record<string, unknown>).reasoningPerMillion as number | undefined;
      cost += reasoningTokens * perToken(reasoningPerMillion ?? pricing.outputPerMillion);
    }
    return cost;
  }

  /** Clear the pricing cache. */
  clearCache(): void {
    this.cache.clear();
  }
}
