import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeModelRates } from "./model-rates.js";
import { PricingService } from "./pricing.js";
import type { ModelSummary } from "./types.js";

// Hermetic: HOME points at an empty temp dir (no real ~/.kosha manifest or
// overrides) and the kosha runtime registry is a small in-memory fake.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-rates-"));
  vi.stubEnv("HOME", home);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function summary(model: string, over: Partial<ModelSummary> = {}): ModelSummary {
  return {
    model,
    provider: "claude-code",
    inputTokens: 1_000,
    outputTokens: 2_000,
    cacheReadTokens: 6_000,
    cacheWriteTokens: 1_000,
    reasoningTokens: 0,
    totalTokens: 10_000,
    cost: 0.05,
    percentageOfTotal: 100,
    ...over,
  };
}

function withFakeKosha(
  pricing: PricingService,
  cards: Record<string, object>,
  all: Array<{ id: string; pricing?: object; originPricing?: object }>
) {
  (pricing as any).registry = {
    model: (id: string) => cards[id],
    models: () => all,
  };
}

describe("computeModelRates", () => {
  it("reports kosha exact rates, Claude's derived 1h write, and the effective $/M", async () => {
    const pricing = new PricingService();
    withFakeKosha(
      pricing,
      {
        "claude-opus-5-5": {
          originPricing: {
            inputPerMillion: 5,
            outputPerMillion: 25,
            cacheReadPerMillion: 0.5,
            cacheWritePerMillion: 6.25,
          },
        },
      },
      []
    );
    const res = await computeModelRates(pricing, [summary("claude-opus-5-5")], "today");
    const card = res.models[0];
    expect(card.source).toEqual({ tier: "kosha-exact" });
    expect(card.rates.input).toEqual({ perMillion: 5, derived: false });
    expect(card.rates.output).toEqual({ perMillion: 25, derived: false });
    expect(card.rates.cacheRead).toEqual({ perMillion: 0.5, derived: false });
    expect(card.rates.cacheWrite).toEqual({ perMillion: 6.25, derived: false });
    expect(card.rates.cacheWrite1h).toEqual({ perMillion: 10, derived: true, basis: "2× input" });
    expect(card.rates.reasoning).toMatchObject({ perMillion: 25, derived: true });
    expect(card.effectivePerMillion).toBeCloseTo(5, 10); // $0.05 over 10K tokens
  });

  it("names the matched registry id on a fuzzy match", async () => {
    const pricing = new PricingService();
    withFakeKosha(pricing, {}, [
      {
        id: "openai/gpt-6-astra",
        originPricing: { inputPerMillion: 2, outputPerMillion: 8, cacheReadPerMillion: 0.2 },
      },
    ]);
    const res = await computeModelRates(
      pricing,
      [summary("gpt-6-astra", { provider: "codex" })],
      "today"
    );
    const card = res.models[0];
    expect(card.source).toEqual({ tier: "kosha-fuzzy", matchedId: "openai/gpt-6-astra" });
    expect(card.rates.input.perMillion).toBe(2);
    // No cache-write price: billing doesn't charge writes, so null, not 0.
    expect(card.rates.cacheWrite).toEqual({ perMillion: null, derived: false });
    expect(card.rates.cacheWrite1h).toEqual({ perMillion: null, derived: false });
  });

  it("reports an unpriced model as null rates, never a guess", async () => {
    const pricing = new PricingService();
    withFakeKosha(pricing, {}, []);
    const res = await computeModelRates(pricing, [summary("mystery-model-xyz")], "all");
    const card = res.models[0];
    expect(res.scope).toBe("all");
    expect(card.source).toEqual({ tier: "unpriced" });
    for (const rate of Object.values(card.rates)) {
      expect(rate).toEqual({ perMillion: null, derived: false });
    }
    expect(card.effectivePerMillion).toBeCloseTo(5, 10);
  });

  it("flags the 10%-of-input cache-read fallback as derived", async () => {
    const pricing = new PricingService();
    withFakeKosha(
      pricing,
      { "plain-model": { originPricing: { inputPerMillion: 3, outputPerMillion: 15 } } },
      []
    );
    const card = (await computeModelRates(pricing, [summary("plain-model")], "today")).models[0];
    expect(card.rates.cacheRead.derived).toBe(true);
    expect(card.rates.cacheRead.basis).toBe("10% of input");
    expect(card.rates.cacheRead.perMillion).toBeCloseTo(0.3, 10);
  });

  it("reports the manifest tier and the normalized id it matched", async () => {
    mkdirSync(join(home, ".kosha"), { recursive: true });
    writeFileSync(
      join(home, ".kosha", "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        models: [{ modelId: "fable-5.1", pricing: { inputPerMillion: 4, outputPerMillion: 20 } }],
      })
    );
    const pricing = new PricingService();
    withFakeKosha(pricing, {}, []);
    const card = (await computeModelRates(pricing, [summary("fable-5-1")], "today")).models[0];
    expect(card.source).toEqual({ tier: "manifest", matchedId: "fable-5.1" });
    expect(card.rates.output.perMillion).toBe(20);
  });

  it("reports a user override as the override tier", async () => {
    const pricing = new PricingService();
    withFakeKosha(pricing, {}, []);
    (pricing as any).userOverrides = new Map([
      ["house-model", { inputPerMillion: 1, outputPerMillion: 2 }],
    ]);
    const card = (await computeModelRates(pricing, [summary("house-model")], "today")).models[0];
    expect(card.source).toEqual({ tier: "override" });
    expect(card.rates.input.perMillion).toBe(1);
  });

  it("rounds fractional token counts so a strict client can decode them", async () => {
    const pricing = new PricingService();
    withFakeKosha(
      pricing,
      { "claude-opus-5-5": { pricing: { inputPerMillion: 4, outputPerMillion: 20 } } },
      []
    );
    const out = await computeModelRates(
      pricing,
      [
        summary("claude-opus-5-5", {
          inputTokens: 1_000.4,
          outputTokens: 2_000.6,
          cacheReadTokens: 5_999.5,
          totalTokens: 10_000.5,
          cost: 1,
        }),
      ],
      "all"
    );
    const u = out.models[0].usage;
    for (const n of [
      u.inputTokens,
      u.outputTokens,
      u.cacheReadTokens,
      u.cacheWriteTokens,
      u.totalTokens,
    ]) {
      expect(Number.isInteger(n)).toBe(true);
    }
    expect(u.inputTokens).toBe(1_000);
    expect(u.outputTokens).toBe(2_001);
    expect(u.totalTokens).toBe(10_001);
    expect(out.models[0].effectivePerMillion).toBeCloseTo((1 / 10_001) * 1_000_000, 6);
  });

  it("returns null effective $/M when there were no tokens", async () => {
    const pricing = new PricingService();
    withFakeKosha(pricing, {}, []);
    const card = (
      await computeModelRates(pricing, [summary("idle", { totalTokens: 0, cost: 0 })], "today")
    ).models[0];
    expect(card.effectivePerMillion).toBeNull();
  });

  it("matches calculateCost: the source never changes the billed cost", async () => {
    const pricing = new PricingService();
    pricing.seedPricing("seeded-model", {
      inputPerMillion: 5,
      outputPerMillion: 25,
      cacheReadPerMillion: 0.5,
      cacheWritePerMillion: 6.25,
    });
    const before = await pricing.calculateCost("seeded-model", 1000, 2000, 6000, 1000);
    const card = (await computeModelRates(pricing, [summary("seeded-model")], "today")).models[0];
    expect(card.source).toEqual({ tier: "seeded" });
    expect(await pricing.calculateCost("seeded-model", 1000, 2000, 6000, 1000)).toBe(before);
    // Rebuild the cost from the card's own rates: it must equal billing.
    const r = card.rates;
    const rebuilt =
      (1000 * (r.input.perMillion ?? 0) +
        2000 * (r.output.perMillion ?? 0) +
        6000 * (r.cacheRead.perMillion ?? 0) +
        1000 * (r.cacheWrite.perMillion ?? 0)) /
      1_000_000;
    expect(rebuilt).toBeCloseTo(before, 12);
  });
});
