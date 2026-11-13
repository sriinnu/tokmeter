/**
 * Which zero rates are prices.
 *
 * Pricing rejected any card unless input and output were both above $0. That
 * guard is right for a $0/$0 catalog row, which usually means nobody listed a
 * price (see docs/how-the-numbers-work.md, "Free models"), but it also threw
 * away two real prices:
 *  - an embedding or rerank model has no output, so its $0 output rate is a
 *    whole price, and its usage was billed as $0 and reported unpriced;
 *  - a "-free" route's $0/$0 is a price, yet the record was then marked
 *    unavailable and counted as an unpriced model.
 * A $0/$0 row on a bare id still prices nothing, and a loose match still
 * never lands on an input-only row.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PricingService } from "./pricing.js";
import { enrichCosts, type UnpricedTracker } from "./pricing-enrichment.js";
import type { TokenRecord } from "./types.js";

let home: string;

const row = (providerId: string, modelId: string, mode: string, input: number, output: number) => ({
  providerId,
  canonicalProviderId: providerId,
  modelId,
  mode,
  pricing: { inputPerMillion: input, outputPerMillion: output },
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-zero-rates-"));
  vi.stubEnv("HOME", home);
  mkdirSync(join(home, ".kosha"), { recursive: true });
  writeFileSync(
    join(home, ".kosha", "registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      models: [
        row("openai", "text-embedding-9-small", "embedding", 0.02, 0),
        row("cohere", "rerank-v9", "rerank", 2, 0),
        // A chat row with no output rate is half a price, not a whole one.
        row("vercel", "half-priced-chat", "chat", 0.5, 0),
        // Listed at $0/$0: in a catalog that usually means "no price".
        row("volcengine", "zero-listed-chat", "chat", 0, 0),
      ],
    })
  );
  writeFileSync(
    join(home, ".kosha", "catalog-only.json"),
    JSON.stringify({
      schemaVersion: 1,
      models: [
        {
          providerId: "opencode",
          canonicalProviderId: "models.dev",
          modelId: "beam-free",
          pricing: { inputPerMillion: 0, outputPerMillion: 0 },
        },
      ],
    })
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

/** A runtime registry that knows one embedding model, and one fuzzy bait. */
function pricingService(): PricingService {
  const pricing = new PricingService();
  (pricing as any).registry = {
    model: (id: string) =>
      id === "embed-live-1"
        ? { mode: "embedding", pricing: { inputPerMillion: 0.1, outputPerMillion: 0 } }
        : undefined,
    models: () => [
      {
        id: "vendor/qwen9-embedding-large",
        mode: "embedding",
        pricing: { inputPerMillion: 0.05, outputPerMillion: 0 },
      },
    ],
  };
  return pricing;
}

function record(model: string, inputTokens: number): TokenRecord {
  return {
    timestamp: 1_790_000_000_000,
    project: "p",
    provider: "opencode",
    model,
    inputTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    usage: {
      source: "tool_jsonl",
      inputTokens: "direct",
      outputTokens: "direct",
      cacheReadTokens: "direct",
      cacheWriteTokens: "direct",
      reasoningTokens: "direct",
      cost: "calculated",
    },
  };
}

describe("input-only models", () => {
  it("prices an embedding model from the saved catalog on input alone", async () => {
    const { pricing, source } =
      await pricingService().getPricingWithSource("text-embedding-9-small");
    expect(pricing).toMatchObject({ inputPerMillion: 0.02, outputPerMillion: 0 });
    expect(source.tier).toBe("manifest");
  });

  it("prices a rerank model and a live-registry embedding model the same way", async () => {
    const svc = pricingService();
    expect(await svc.getPricing("rerank-v9")).toMatchObject({ inputPerMillion: 2 });
    const live = await svc.getPricingWithSource("embed-live-1");
    expect(live.pricing).toMatchObject({ inputPerMillion: 0.1, outputPerMillion: 0 });
    expect(live.source.tier).toBe("kosha-exact");
  });

  it("bills the input tokens instead of reporting the model unpriced", async () => {
    const svc = pricingService();
    const tracker: UnpricedTracker = { models: new Set(), records: 0 };
    const r = record("text-embedding-9-small", 1_000_000);
    await enrichCosts([r], svc, "today", [], tracker);
    expect(r.cost).toBeCloseTo(0.02, 9);
    expect(r.usage?.cost).toBe("calculated");
    expect(tracker.models.size).toBe(0);
  });

  it("still refuses a chat model with no output rate", async () => {
    expect(await pricingService().getPricing("half-priced-chat")).toBeNull();
  });

  it("never lets a loose match land on an input-only row", async () => {
    // "qwen9-embedding" is contained in the bait's id; an exact id is needed.
    expect(await pricingService().getPricing("qwen9-embedding")).toBeNull();
  });
});

describe("zero rates", () => {
  it("keeps a free route's $0 as a price, not a gap", async () => {
    const svc = pricingService();
    const tracker: UnpricedTracker = { models: new Set(), records: 0 };
    const r = record("beam-free@opencode", 50_000);
    await enrichCosts([r], svc, "today", [], tracker);
    expect(r.cost).toBe(0);
    expect(r.usage?.cost).toBe("calculated");
    expect(tracker.models.size).toBe(0);
    expect(svc.isPricedFree("beam-free@opencode")).toBe(true);
  });

  it("still reads a bare $0/$0 catalog row as no price", async () => {
    const svc = pricingService();
    const tracker: UnpricedTracker = { models: new Set(), records: 0 };
    const r = record("zero-listed-chat", 50_000);
    await enrichCosts([r], svc, "today", [], tracker);
    expect(await svc.getPricing("zero-listed-chat")).toBeNull();
    expect(svc.isPricedFree("zero-listed-chat")).toBe(false);
    expect(r.usage?.cost).toBe("not_exposed");
    expect(tracker.models.has("zero-listed-chat")).toBe(true);
  });

  it("calls a paid model priced, not free", async () => {
    const svc = pricingService();
    await svc.getPricing("text-embedding-9-small");
    expect(svc.isPricedFree("text-embedding-9-small")).toBe(false);
  });
});

describe("a :free route beside its paid twin", () => {
  it("bills the free row, not the paid model the tag was stripped to", async () => {
    // Real shape (kenari, 2026-11-12): both rows sit under one provider.
    const free = { inputPerMillion: 0, outputPerMillion: 0 };
    writeFileSync(
      join(home, ".kosha", "catalog-only.json"),
      JSON.stringify({
        schemaVersion: 1,
        models: [
          {
            providerId: "kenari",
            canonicalProviderId: "models.dev",
            modelId: "kimi-k2-6",
            pricing: { inputPerMillion: 0.571, outputPerMillion: 2.857 },
          },
          {
            providerId: "kenari",
            canonicalProviderId: "models.dev",
            modelId: "kimi-k2-6:free",
            pricing: free,
          },
        ],
      })
    );
    const svc = pricingService();
    const { pricing, source } = await svc.getPricingWithSource("kimi-k2-6:free@kenari");
    expect(pricing).toMatchObject(free);
    expect(source).toEqual({ tier: "kosha-provider", matchedId: "kenari:kimi-k2-6:free" });
    expect(svc.isPricedFree("kimi-k2-6:free@kenari")).toBe(true);
    // The paid twin keeps its price.
    expect(await svc.getPricing("kimi-k2-6@kenari")).toMatchObject({ inputPerMillion: 0.571 });
  });

  it("leaves a :free id unpriced when no free row exists, never at the paid rate", async () => {
    // Real shape: kenari lists a free row for some models, not this one, and
    // kosha's live lookup resolves "x:free" to the paid "x" card.
    writeFileSync(
      join(home, ".kosha", "catalog-only.json"),
      JSON.stringify({
        schemaVersion: 1,
        models: [
          {
            providerId: "kenari",
            canonicalProviderId: "models.dev",
            modelId: "deepseek-v9-pro",
            pricing: { inputPerMillion: 0.571429, outputPerMillion: 1.142857 },
          },
        ],
      })
    );
    const svc = pricingService();
    (svc as any).registry.model = (id: string) =>
      id.replace(/:free$/, "") === "deepseek-v9-pro"
        ? { mode: "chat", pricing: { inputPerMillion: 0.95, outputPerMillion: 4 } }
        : undefined;
    expect(await svc.getPricing("deepseek-v9-pro:free@kenari")).toBeNull();
    expect(await svc.getPricing("deepseek-v9-pro:free")).toBeNull();
    expect((await svc.getPricingWithSource("deepseek-v9-pro:free")).source.tier).toBe("unpriced");
    // The paid id still prices both ways.
    expect((await svc.getPricing("deepseek-v9-pro@kenari"))?.inputPerMillion).toBeCloseTo(0.571429);
    expect(await svc.getPricing("deepseek-v9-pro")).toMatchObject({ inputPerMillion: 0.95 });
  });
});
