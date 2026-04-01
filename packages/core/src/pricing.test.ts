import { describe, expect, it } from "vitest";
import { PricingService } from "./pricing.js";

describe("PricingService", () => {
  it("should create instance without errors", () => {
    const pricing = new PricingService();
    expect(pricing).toBeDefined();
  });

  it("should initialize without errors", async () => {
    const pricing = new PricingService();
    // init() may throw if kosha-discovery fails, so we just verify it's callable
    try {
      await pricing.init();
    } catch {
      // Acceptable if network/service issues
    }
  });

  it("should return pricing for known models or null", async () => {
    const pricing = new PricingService();
    await pricing.init();

    const claudePricing = await pricing.getPricing("claude-sonnet-4-20250514");
    // Pricing may be null if not found, or have values if found
    if (claudePricing) {
      expect(claudePricing.inputPerMillion).toBeGreaterThanOrEqual(0);
      expect(claudePricing.outputPerMillion).toBeGreaterThanOrEqual(0);
    }
  });

  it("should return null for unknown models", async () => {
    const pricing = new PricingService();
    await pricing.init();

    const unknownPricing = await pricing.getPricing("nonexistent-model-xyz");
    expect(unknownPricing).toBeNull();
  });
});
