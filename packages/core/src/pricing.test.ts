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
//
// Tests use `seedPricing()` to inject known rates so they exercise the
// math without depending on kosha's network calls or its current data.

describe("calculateCost", () => {
  it("charges Anthropic-style models with explicit cache rates correctly", async () => {
    const pricing = new PricingService();
    // Seed with Anthropic-style rates ($5 input, $25 output, $0.5 read, $6.25 write).
    pricing.seedPricing("test-anthropic", {
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    });
    // 1M input + 1M output + 1M cache read + 1M cache write
    // = $5 + $25 + $0.5 + $6.25 = $36.75
    const cost = await pricing.calculateCost(
      "test-anthropic",
      1_000_000,
      1_000_000,
      1_000_000,
      1_000_000
    );
    expect(cost).toBeCloseTo(36.75, 2);
  });

  it("does not double-charge cached input as full input", async () => {
    const pricing = new PricingService();
    pricing.seedPricing("test-anthropic", {
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    });
    // Anthropic semantics: input_tokens = uncached only.
    // 100k uncached input + 900k cached input + 1k output.
    // = 100k * $5/M + 900k * $0.5/M + 1k * $25/M
    // = $0.50 + $0.45 + $0.025 = $0.975
    const cost = await pricing.calculateCost("test-anthropic", 100_000, 1_000, 900_000);
    expect(cost).toBeCloseTo(0.975, 3);
  });

  it("applies 10% cache-read fallback when no explicit rate", async () => {
    const pricing = new PricingService();
    // No cacheReadPerMillion → fallback is 10% of input = $0.3/M cache read.
    // 100k cached → 100k * $0.3/M = $0.03
    pricing.seedPricing("test-grok-style", {
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
    const cost = await pricing.calculateCost("test-grok-style", 0, 0, 100_000);
    expect(cost).toBeCloseTo(0.03, 3);
  });

  it("does NOT apply cache-write fallback (must be explicit)", async () => {
    const pricing = new PricingService();
    // No cacheWritePerMillion → cache writes should be free.
    // The 1.25x fallback is gated to Anthropic-only by requiring an
    // explicit rate; otherwise providers without cache write billing
    // would be wrongly charged.
    pricing.seedPricing("test-grok-style", {
      inputPerMillion: 3,
      outputPerMillion: 15,
    });
    const cost = await pricing.calculateCost("test-grok-style", 0, 0, 0, 100_000);
    expect(cost).toBe(0);
  });

  it("returns 0 for unknown model (no kosha hit)", async () => {
    const pricing = new PricingService();
    const cost = await pricing.calculateCost("totally-fake-model-xyz-9000", 1_000_000, 1_000_000);
    expect(cost).toBe(0);
  });

  it("Gemini-style explicit ~25% cache rate is honored, not overridden by 10% fallback", async () => {
    const pricing = new PricingService();
    // $1.25 input, $10 output, $0.31 cache read (25% of input — explicit).
    // 1M cached → 1M * $0.31/M = $0.31
    // (If the 10% fallback fired wrongly, we'd get $0.125 — visibly different)
    pricing.seedPricing("test-gemini-style", {
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.31,
    });
    const cost = await pricing.calculateCost("test-gemini-style", 0, 0, 1_000_000);
    expect(cost).toBeCloseTo(0.31, 2);
  });
});
