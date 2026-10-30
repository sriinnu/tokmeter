/**
 * Regression tests for the `costEligible: false` opt-out.
 *
 * Found via a real bug: a parser can have real, non-zero token counts for a
 * model kosha genuinely prices (so the normal "no pricing available"
 * not_exposed path never fires), while still not trusting the input/output
 * split enough to compute a dollar figure — codex-desktop.ts's SQLite
 * fallback is the concrete case (one lump `tokens_used` total, no tier
 * split). Without this flag, enrichCosts blindly priced the lump total at
 * the model's output rate on a live install (a real Sol session showed
 * $12.65 computed from a token count that was never actually "output").
 */

import { describe, expect, it } from "vitest";
import { PricingService } from "./pricing.js";
import { enrichCosts, resetCalculatedCosts, type UnpricedTracker } from "./pricing-enrichment.js";
import type { ScanWarning, TokenRecord } from "./types.js";

function makeRecord(overrides: Partial<TokenRecord> = {}): TokenRecord {
  return {
    timestamp: Date.now(),
    project: "test",
    provider: "codex-desktop",
    model: "gpt-5.6-sol",
    inputTokens: 0,
    outputTokens: 100_000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    usage: {
      source: "tool_sqlite",
      inputTokens: "not_exposed",
      outputTokens: "direct",
      cacheReadTokens: "not_exposed",
      cacheWriteTokens: "not_exposed",
      reasoningTokens: "not_exposed",
      cost: "not_exposed",
    },
    ...overrides,
  };
}

describe("enrichCosts — costEligible", () => {
  it("preserves an explicit tool-reported zero instead of repricing it", async () => {
    const pricing = new PricingService();
    pricing.seedPricing("gpt-5.6-sol", { inputPerMillion: 5, outputPerMillion: 30 });
    const record = makeRecord();
    record.usage!.cost = "direct";
    await enrichCosts([record], pricing, "today", []);
    expect(record.cost).toBe(0);
    expect(record.usage?.cost).toBe("direct");
  });
  it("prices a record normally when the model has real pricing and costEligible is unset", async () => {
    const pricing = new PricingService();
    pricing.seedPricing("gpt-5.6-sol", { inputPerMillion: 5, outputPerMillion: 30 });
    const warnings: ScanWarning[] = [];
    const record = makeRecord();

    await enrichCosts([record], pricing, "today", warnings);

    // 100_000 output tokens @ $30/M = $3.
    expect(record.cost).toBeCloseTo(3, 6);
    expect(record.usage?.cost).toBe("calculated");
  });

  it("leaves cost at 0 and marks not_exposed when costEligible is false, even with real pricing available", async () => {
    const pricing = new PricingService();
    pricing.seedPricing("gpt-5.6-sol", { inputPerMillion: 5, outputPerMillion: 30 });
    const warnings: ScanWarning[] = [];
    const unpricedTracker: UnpricedTracker = { models: new Set(), records: 0 };
    const record = makeRecord({ costEligible: false });

    await enrichCosts([record], pricing, "today", warnings, unpricedTracker);

    expect(record.cost).toBe(0);
    expect(record.usage?.cost).toBe("not_exposed");
    // Must NOT be tracked as "unpriced" — kosha genuinely has this model's
    // rates; this isn't a missing-pricing-data problem, so flagging it would
    // wrongly beg the kosha wishlist for a model it already has.
    expect(unpricedTracker.models.has("gpt-5.6-sol")).toBe(false);
    expect(unpricedTracker.records).toBe(0);
  });

  it("still tracks a genuinely unpriced model when costEligible is unset", async () => {
    const pricing = new PricingService();
    const warnings: ScanWarning[] = [];
    const unpricedTracker: UnpricedTracker = { models: new Set(), records: 0 };
    const record = makeRecord({ model: "totally-unknown-model-xyz" });

    await enrichCosts([record], pricing, "today", warnings, unpricedTracker);

    expect(record.cost).toBe(0);
    expect(record.usage?.cost).toBe("not_exposed");
    expect(unpricedTracker.models.has("totally-unknown-model-xyz")).toBe(true);
  });
});

describe("enrichCosts — opaque models and price-as overrides", () => {
  const reviewer = () =>
    makeRecord({
      provider: "codex",
      model: "codex-auto-review",
      inputTokens: 14_145_601,
      cacheReadTokens: 154_895_232,
      outputTokens: 118_321,
      reasoningTokens: 57_008,
      usage: undefined,
    });

  it("marks an opaque model's $0 as not exposed, not calculated, and doesn't flag it unpriced", async () => {
    // The bar showed codex-auto-review at "$0.00", which reads as free. Its
    // price is hidden by the provider, so the record says so and every
    // surface shows "—"; the amber unpriced pill still stays quiet.
    const pricing = new PricingService();
    const tracker: UnpricedTracker = { models: new Set(), records: 0 };
    const record = {
      ...reviewer(),
      usage: { ...makeRecord().usage!, cost: "calculated" as const },
    };
    await enrichCosts([record], pricing, "today", [], tracker);
    expect(record.cost).toBe(0);
    expect(record.usage?.cost).toBe("not_exposed");
    expect(tracker.records).toBe(0);
  });

  it("prices an opaque model as the model its `as` override names", async () => {
    const pricing = new PricingService();
    pricing.seedPricing("gpt-5.6-luna", {
      inputPerMillion: 0.2,
      outputPerMillion: 1.2,
      cacheReadPerMillion: 0.02,
    });
    pricing.seedPriceAs("codex-auto-review", "gpt-5.6-luna");
    const record = {
      ...reviewer(),
      usage: { ...makeRecord().usage!, cost: "not_exposed" as const },
    };
    await enrichCosts([record], pricing, "today", []);
    // 14.1456M × $0.20 + 154.895M × $0.02 + (0.118M + 0.057M) × $1.20 ≈ $6.14
    expect(record.cost).toBeCloseTo(6.137, 2);
    expect(record.usage?.cost).toBe("calculated");
    expect((await pricing.getPricingWithSource("codex-auto-review")).source).toEqual({
      tier: "override",
      matchedId: "gpt-5.6-luna",
    });
  });

  it("an `as` naming an unknown or aliased model stays unpriced", async () => {
    const pricing = new PricingService();
    pricing.seedPriceAs("model-a", "nowhere-model-xyz");
    expect(await pricing.getPricing("model-a")).toBeNull();
    pricing.seedPricing("real-model", { inputPerMillion: 1, outputPerMillion: 1 });
    pricing.seedPriceAs("model-b", "model-c");
    pricing.seedPriceAs("model-c", "real-model");
    // One hop only: b → c is itself an alias, so b doesn't chain to real-model.
    expect(await pricing.getPricing("model-b")).toBeNull();
    expect(await pricing.getPricing("model-c")).not.toBeNull();
  });
});

describe("resetCalculatedCosts", () => {
  const withCost = (cost: number, kind: "calculated" | "direct" | undefined): TokenRecord => {
    const base = makeRecord({ cost });
    return kind && base.usage
      ? { ...base, usage: { ...base.usage, cost: kind } }
      : { ...base, usage: undefined };
  };

  it("zeroes calculated costs but keeps tool-reported ones", () => {
    const calculated = withCost(1.5, "calculated");
    const direct = withCost(2.25, "direct");
    const noUsage = withCost(0.5, undefined);
    resetCalculatedCosts([calculated, direct, noUsage]);
    expect(calculated.cost).toBe(0);
    expect(direct.cost).toBe(2.25);
    expect(noUsage.cost).toBe(0);
  });
});
