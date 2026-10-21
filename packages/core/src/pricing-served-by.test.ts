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
