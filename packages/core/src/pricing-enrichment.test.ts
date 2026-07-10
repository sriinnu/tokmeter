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
import { type UnpricedTracker, enrichCosts } from "./pricing-enrichment.js";
import { PricingService } from "./pricing.js";
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
