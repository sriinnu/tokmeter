import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openCodeMessageToRecord } from "./parsers/opencode-db.js";
import { PricingService, splitServedBy, withServedBy } from "./pricing.js";

// Hermetic: HOME is a temp dir holding a small saved catalog, and the kosha
// runtime registry is a fake that knows only the bare model id, the way a
// name-only lookup used to resolve every route to one provider's price.
let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-served-by-"));
  vi.stubEnv("HOME", home);
  mkdirSync(join(home, ".kosha"), { recursive: true });
  const route = (providerId: string, modelId: string, input: number, output: number) => ({
    providerId,
    canonicalProviderId: providerId,
    modelId,
    pricing: { inputPerMillion: input, outputPerMillion: output },
  });
  writeFileSync(
    join(home, ".kosha", "registry.json"),
    JSON.stringify({
      schemaVersion: 1,
      models: [
        route("alibaba-cn", "deepseek-v4.1-flash", 0.3, 1.2),
        route("ollama-cloud", "deepseek-v4.1-flash", 0.15, 0.6),
        route("openrouter", "deepseek/deepseek-v4.1-flash:batch", 0.05, 0.15),
        route("openrouter", "deepseek/deepseek-v4.1-flash", 0.016, 0.89),
      ],
    })
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

function pricingService(): PricingService {
  const pricing = new PricingService();
  (pricing as any).registry = {
    model: (id: string) =>
      id === "deepseek-v4.1-flash"
        ? { pricing: { inputPerMillion: 0.3, outputPerMillion: 1.2 } }
        : undefined,
    models: () => [],
  };
  return pricing;
}

describe("splitServedBy", () => {
  it("reads a provider suffix and leaves dates and plain ids alone", () => {
    expect(splitServedBy("deepseek-v4.1-flash:1017@ollama-cloud")).toEqual({
      model: "deepseek-v4.1-flash:1017",
      servedBy: "ollama-cloud",
    });
    expect(splitServedBy("claude-sonnet-4@20250514")).toEqual({
      model: "claude-sonnet-4@20250514",
    });
    expect(splitServedBy("deepseek-v4.1-flash")).toEqual({ model: "deepseek-v4.1-flash" });
    expect(withServedBy("m", undefined)).toBe("m");
    expect(withServedBy("m", "OpenRouter")).toBe("m@openrouter");
  });
});

describe("pricing a model by who served it", () => {
  it("bills each route at its own provider's rate", async () => {
    const pricing = pricingService();
    const ollama = await pricing.getPricingWithSource("deepseek-v4.1-flash:1017@ollama-cloud");
    expect(ollama.pricing).toMatchObject({ inputPerMillion: 0.15, outputPerMillion: 0.6 });
    expect(ollama.source).toEqual({
      tier: "kosha-provider",
      matchedId: "ollama-cloud:deepseek-v4.1-flash",
    });

    const openrouter = await pricing.getPricing("deepseek/deepseek-v4.1-flash@openrouter");
    expect(openrouter).toMatchObject({ inputPerMillion: 0.016, outputPerMillion: 0.89 });
  });

  it("lands a loose match on the plain route, not a batch variant", async () => {
    const pricing = pricingService();
    const p = await pricing.getPricingWithSource("deepseek-v4.1-flash@openrouter");
    expect(p.source.matchedId).toBe("openrouter:deepseek/deepseek-v4.1-flash");
  });

  it("falls back to the bare model when the provider isn't in the catalog", async () => {
    const pricing = pricingService();
    const p = await pricing.getPricingWithSource("deepseek-v4.1-flash@opencode-go");
    expect(p.pricing).toMatchObject({ inputPerMillion: 0.3, outputPerMillion: 1.2 });
    expect(p.source.tier).toBe("kosha-exact");
  });

  it("lets an override name the exact route", async () => {
    const pricing = pricingService();
    (pricing as any).userOverrides = new Map([
      ["deepseek-v4.1-flash@ollama-cloud", { inputPerMillion: 0.1, outputPerMillion: 0.2 }],
    ]);
    const p = await pricing.getPricingWithSource("deepseek-v4.1-flash@ollama-cloud");
    expect(p).toEqual({
      pricing: { inputPerMillion: 0.1, outputPerMillion: 0.2 },
      source: { tier: "override" },
    });
  });
});

describe("OpenCode records name their serving provider", () => {
  const msg = (providerID: string | undefined, modelID: string, cost: number) => ({
    role: "assistant",
    providerID,
    modelID,
    cost,
    tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: new Date("2026-10-20T12:00:00").getTime() },
  });

  it("puts providerID on the model, and keeps free variants free", () => {
    const routed = openCodeMessageToRecord(
      msg("ollama-cloud", "deepseek-v4.1-flash:1017", 0) as never,
      "opencode",
      "/db"
    );
    expect(routed?.model).toBe("deepseek-v4.1-flash:1017@ollama-cloud");

    const free = openCodeMessageToRecord(
      msg("opencode", "deepseek-v4.1-flash-free", 0) as never,
      "opencode",
      "/db"
    );
    expect(free?.model).toBe("deepseek-v4.1-flash-free@opencode");
    expect(free?.usage?.cost).toBe("direct");

    const bare = openCodeMessageToRecord(
      msg(undefined, "some-model", 0) as never,
      "opencode",
      "/db"
    );
    expect(bare?.model).toBe("some-model");
  });
});

describe("catalog-only.json", () => {
  const row = (providerId: string, modelId: string, input: number, output: number) => ({
    providerId,
    canonicalProviderId: "models.dev",
    modelId,
    pricing: { inputPerMillion: input, outputPerMillion: output },
  });
  const write = (body: string) => writeFileSync(join(home, ".kosha", "catalog-only.json"), body);
  const catalog = () =>
    write(
      JSON.stringify({
        schemaVersion: 1,
        models: [
          row("opencode", "beam-free", 0, 0),
          row("opencode-go", "kimi-k3.1-pro", 2, 10),
          row("amd", "deepseek-v4.1-flash", 0, 0),
          row("aihubmix", "qwen3.8-max-preview", 0.338, 1.014),
          row("ollama-cloud", "deepseek-v4.1-flash", 99, 99),
        ],
      })
    );

  it("prices a free model from the provider that lists it", async () => {
    catalog();
    expect(await pricingService().getPricing("beam-free@opencode")).toMatchObject({
      inputPerMillion: 0,
      outputPerMillion: 0,
    });
  });

  it("prices a paid route at that provider's own rate", async () => {
    catalog();
    expect(await pricingService().getPricing("kimi-k3.1-pro@opencode-go")).toMatchObject({
      inputPerMillion: 2,
      outputPerMillion: 10,
    });
  });

  it("never answers a bare model name", async () => {
    catalog();
    const pricing = pricingService();
    expect(await pricing.getPricing("qwen3.8-max-preview")).toBeNull();
    expect(await pricing.getPricing("beam-free")).toBeNull();
  });

  it("doesn't let one provider's row answer for another", async () => {
    catalog();
    expect(await pricingService().getPricing("qwen3.8-max-preview@opencode")).toBeNull();
  });

  it("lets the registry win a route both files list", async () => {
    catalog();
    expect(await pricingService().getPricing("deepseek-v4.1-flash@ollama-cloud")).toMatchObject({
      inputPerMillion: 0.15,
    });
  });

  it("doesn't read a $0 as free unless the id says so", async () => {
    catalog();
    // amd lists it at $0: an unknown rate, so it prices as the bare model.
    const pricing = await pricingService().getPricing("deepseek-v4.1-flash@amd");
    expect(pricing?.inputPerMillion).toBeGreaterThan(0);
  });

  it("carries on when the file is missing, malformed or the wrong schema", async () => {
    expect(await pricingService().getPricing("beam-free@opencode")).toBeNull();
    write("{not json");
    expect(await pricingService().getPricing("beam-free@opencode")).toBeNull();
    write(JSON.stringify({ schemaVersion: 99, models: [row("opencode", "beam-free", 0, 0)] }));
    expect(await pricingService().getPricing("beam-free@opencode")).toBeNull();
  });

  it("doesn't open the file for a lookup the registry can answer", async () => {
    write("{not json");
    const service = pricingService();
    const spy = vi.spyOn(
      service as unknown as { loadCatalogOnly: () => unknown },
      "loadCatalogOnly"
    );
    await service.getPricing("deepseek-v4.1-flash@ollama-cloud");
    await service.getPricing("deepseek-v4.1-flash");
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("getPriceFlags", () => {
  const row = (providerId: string, input: number, rawCapabilities: string[]) => ({
    providerId,
    canonicalProviderId: providerId,
    modelId: "m-1",
    pricing: { inputPerMillion: input, outputPerMillion: 2 },
    rawCapabilities,
  });
  const rates = (input: number) => ({ inputPerMillion: input, outputPerMillion: 2 });

  beforeEach(() => {
    writeFileSync(
      join(home, ".kosha", "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        models: [
          row("direct", 1, ["pricing_sources_disagree", "chat"]),
          row("gateway", 3, ["pricing_quarantined", "pricing_single_source"]),
          row("clean", 5, ["chat"]),
        ],
      })
    );
  });

  it("reads the flags of the row carrying this price", () => {
    const pricing = pricingService();
    expect(pricing.getPriceFlags("m-1", rates(1))).toEqual(["disputed"]);
    expect(pricing.getPriceFlags("m-1", rates(3))).toEqual(["held", "single-source"]);
    expect(pricing.getPriceFlags("m-1", rates(5))).toEqual([]);
  });

  it("doesn't borrow a flag from another provider's price", () => {
    const pricing = pricingService();
    expect(pricing.getPriceFlags("m-1@clean", rates(5))).toEqual([]);
    expect(pricing.getPriceFlags("m-1@clean", rates(1))).toEqual([]);
    expect(pricing.getPriceFlags("m-1@direct", rates(1))).toEqual(["disputed"]);
  });

  it("has nothing to say about an unpriced model or a missing file", () => {
    const pricing = pricingService();
    expect(pricing.getPriceFlags("m-1", null)).toEqual([]);
    rmSync(join(home, ".kosha", "registry.json"));
    expect(pricingService().getPriceFlags("m-1", rates(1))).toEqual([]);
  });
});
