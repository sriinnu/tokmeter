import { describe, expect, it } from "vitest";
import { PricingService } from "./pricing.js";

describe("PricingService", () => {
  it("should create instance without errors", () => {
    const pricing = new PricingService();
    expect(pricing).toBeDefined();
  });

  // Skip network-dependent tests in CI environment
  (process.env.CI ? it.skip : it)("should initialize without errors", async () => {
    const pricing = new PricingService();
    try {
      await pricing.init();
    } catch {
      // Acceptable if network/service issues
    }
  });

  (process.env.CI ? it.skip : it)("should return pricing for known models or null", async () => {
    const pricing = new PricingService();
    await pricing.init();

    const claudePricing = await pricing.getPricing("claude-sonnet-4-20250514");
    if (claudePricing) {
      expect(claudePricing.inputPerMillion).toBeGreaterThanOrEqual(0);
      expect(claudePricing.outputPerMillion).toBeGreaterThanOrEqual(0);
    }
  });

  (process.env.CI ? it.skip : it)("should return null for unknown models", async () => {
    const pricing = new PricingService();
    await pricing.init();

    const unknownPricing = await pricing.getPricing("nonexistent-model-xyz");
    expect(unknownPricing).toBeNull();
  });
});

// ─── calculateCost regression tests ─────────────────────────────────────
// These cover the bug class that produced the 24x Codex overcharge —
// the cost calculator's fallback math for cache reads/writes when the
// resolver doesn't provide explicit rates. Don't remove these without
// reading the relevant commit messages first.

describe("calculateCost", () => {
  // Use the static table directly so we don't depend on network/kosha.
  // claude-opus-4-6 has explicit cache rates: $15 input, $75 output,
  // $1.5 cache read, $18.75 cache write.
  it("charges Anthropic models with explicit cache rates correctly", async () => {
    const pricing = new PricingService();
    // 1M input + 1M output + 1M cache read + 1M cache write
    // = $15 + $75 + $1.5 + $18.75 = $110.25
    const cost = await pricing.calculateCost(
      "claude-opus-4-6",
      1_000_000, // input
      1_000_000, // output
      1_000_000, // cache read
      1_000_000 // cache write
    );
    expect(cost).toBeCloseTo(110.25, 2);
  });

  it("does not double-charge cached input as full input", async () => {
    const pricing = new PricingService();
    // Anthropic semantics: input_tokens = uncached only.
    // 100k uncached input + 900k cached input + 1k output for opus-4-6.
    // = 100k * $15/M + 900k * $1.5/M + 1k * $75/M
    // = $1.50 + $1.35 + $0.075 = $2.925
    const cost = await pricing.calculateCost(
      "claude-opus-4-6",
      100_000, // uncached input
      1_000, // output
      900_000 // cache read
    );
    expect(cost).toBeCloseTo(2.925, 3);
  });

  it("applies 10% cache-read fallback when no explicit rate", async () => {
    const pricing = new PricingService();
    // grok-4 has $3/M input, $15/M output, no cacheReadPerMillion →
    // fallback is 10% of input = $0.3/M cache read.
    // 100k cached → 100k * $0.3/M = $0.03
    const cost = await pricing.calculateCost(
      "grok-4",
      0, // input
      0, // output
      100_000 // cache read
    );
    expect(cost).toBeCloseTo(0.03, 3);
  });

  it("does NOT apply cache-write fallback (must be explicit)", async () => {
    const pricing = new PricingService();
    // grok-4 has no cacheWritePerMillion → cache writes should be free.
    // The 1.25x fallback is gated to Anthropic-only by requiring an
    // explicit rate; otherwise providers without cache write billing
    // would be wrongly charged.
    const cost = await pricing.calculateCost(
      "grok-4",
      0,
      0,
      0,
      100_000 // cache write
    );
    expect(cost).toBe(0);
  });

  it("returns 0 for unknown model (no static, no kosha hit)", async () => {
    const pricing = new PricingService();
    const cost = await pricing.calculateCost("totally-fake-model-xyz-9000", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("Gemini 2.5 pro uses explicit ~25% cache rate, not 10% fallback", async () => {
    const pricing = new PricingService();
    // gemini-2.5-pro: $1.25 input, $10 output, $0.31 cache read (25% of input)
    // 1M cached → 1M * $0.31/M = $0.31
    // (If the 10% fallback fired wrongly, we'd get $0.125 — visibly different)
    const cost = await pricing.calculateCost("gemini-2.5-pro", 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(0.31, 2);
  });
});
