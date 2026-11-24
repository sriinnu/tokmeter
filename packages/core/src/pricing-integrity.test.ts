import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, saveConfig } from "./config-service.js";
import { PricingService } from "./pricing.js";
import { scanRawRecords } from "./scan-pipeline.js";
import { TokmeterCore } from "./tokmeter-core.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "tokmeter-pricing-integrity-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  mkdirSync(join(home, ".kosha"), { recursive: true });
  mkdirSync(join(home, ".tokmeter"), { recursive: true });
});

afterEach(() => {
  vi.unstubAllEnvs();
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

describe("pricing resolution integrity (#287)", () => {
  it("resolves `{ as }` overrides on servedBy (`model@provider`) IDs", async () => {
    writeFileSync(
      join(home, ".tokmeter", "pricing-overrides.json"),
      JSON.stringify({
        "codex-auto-review@openai": { as: "target-model" },
        "target-model": { inputPerMillion: 2, outputPerMillion: 8 },
      })
    );
    const pricing = new PricingService();
    await pricing.init();
    const { pricing: card, source } = await pricing.getPricingWithSource(
      "codex-auto-review@openai"
    );
    expect(card).toMatchObject({ inputPerMillion: 2, outputPerMillion: 8 });
    expect(source).toEqual({ tier: "override", matchedId: "target-model" });
  });

  it("prices bare `-free`/`:free` rows from registry.json at $0/$0 while keeping catalog-only scoped", async () => {
    writeFileSync(
      join(home, ".kosha", "registry.json"),
      JSON.stringify({
        schemaVersion: 1,
        models: [
          {
            providerId: "openrouter",
            canonicalProviderId: "openrouter",
            modelId: "qwen/qwen3-coder:free",
            pricing: { inputPerMillion: 0, outputPerMillion: 0 },
          },
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

    const pricing = new PricingService();
    await pricing.init();

    const freeRes = await pricing.getPricingWithSource("qwen/qwen3-coder:free");
    expect(freeRes.pricing).toEqual({ inputPerMillion: 0, outputPerMillion: 0 });
    expect(freeRes.source.tier).toBe("manifest");
    expect(pricing.isPricedFree("qwen/qwen3-coder:free")).toBe(true);

    // catalog-only entries still never answer bare lookups
    expect(await pricing.getPricing("beam-free")).toBeNull();
    expect(await pricing.getPricing("missing-model:free")).toBeNull();
  });

  it("tightens koshaFuzzyMatch against short/substring mismatches and prefers direct originPricing", async () => {
    const pricing = new PricingService();
    (pricing as any).registry = {
      model: () => undefined,
      models: () => [
        {
          id: "openrouter/gpt-4o",
          pricing: { inputPerMillion: 9, outputPerMillion: 99 },
        },
        {
          id: "openrouter/anthropic/claude-opus-4-6",
          pricing: { inputPerMillion: 9, outputPerMillion: 45 },
        },
        {
          id: "anthropic/claude-opus-4-6",
          originPricing: { inputPerMillion: 5, outputPerMillion: 25 },
          pricing: { inputPerMillion: 8, outputPerMillion: 40 },
        },
        {
          id: "openai/some-mini-model",
          pricing: { inputPerMillion: 1, outputPerMillion: 2 },
        },
      ],
    };

    // Short / substring-only queries must not fuzzy-match unrelated models.
    expect(await pricing.getPricing("mini")).toBeNull();
    expect(await pricing.getPricing("gpt-4")).toBeNull();

    // Direct originPricing wins exact-base ties over proxy rows.
    const { pricing: card, source } = await pricing.getPricingWithSource("claude-opus-4.6");
    expect(card).toMatchObject({ inputPerMillion: 5, outputPerMillion: 25 });
    expect(source).toEqual({ tier: "kosha-fuzzy", matchedId: "anthropic/claude-opus-4-6" });
  });

  it("validates and rounds schedule.offPeak rates and rejects malformed schedules", async () => {
    const pricing = new PricingService();
    (pricing as any).registry = {
      model: (id: string) => {
        if (id === "good-schedule") {
          return {
            originPricing: {
              inputPerMillion: 1,
              outputPerMillion: 2,
              schedule: {
                source: "provider-docs",
                peakWindows: [{ days: [1, 2], startHourUtc: 8, endHourUtc: 18 }],
                offPeak: {
                  inputPerMillion: 0.33333349,
                  outputPerMillion: 0.66666649,
                  cacheReadPerMillion: 0.1111119,
                },
              },
            },
          };
        }
        if (id === "bad-offpeak") {
          return {
            originPricing: {
              inputPerMillion: 1,
              outputPerMillion: 2,
              schedule: {
                source: "broken",
                peakWindows: [{ days: [1], startHourUtc: 8, endHourUtc: 18 }],
                offPeak: { inputPerMillion: -1, outputPerMillion: 1 },
              },
            },
          };
        }
        if (id === "bad-windows") {
          return {
            originPricing: {
              inputPerMillion: 1,
              outputPerMillion: 2,
              schedule: {
                source: "broken",
                peakWindows: "not-an-array",
                offPeak: { inputPerMillion: 0.5, outputPerMillion: 1 },
              },
            },
          };
        }
        return undefined;
      },
      models: () => [],
    };

    const good = await pricing.getPricing("good-schedule");
    expect(good?.schedule?.offPeak).toEqual({
      inputPerMillion: 0.333333,
      outputPerMillion: 0.666666,
      cacheReadPerMillion: 0.111112,
    });
    expect(await pricing.getPricing("bad-offpeak")).toBeNull();
    expect(await pricing.getPricing("bad-windows")).toBeNull();
  });
});

describe("custom provider remap & refreshToday unpriced tracking (#287)", () => {
  it("remaps CUSTOM_ELIGIBLE provider filters to custom-source parser without leaking sibling providers", async () => {
    const ribhuDir = join(home, ".ribhu-sessions");
    const chitraDir = join(home, ".chitra-sessions");
    mkdirSync(ribhuDir, { recursive: true });
    mkdirSync(chitraDir, { recursive: true });
    const now = Date.now();
    writeFileSync(
      join(ribhuDir, "a.jsonl"),
      `${JSON.stringify({
        ts: now,
        id: "ribhu-1",
        model: "claude-opus-4-6",
        input_tokens: 100,
        output_tokens: 50,
        cost: 0.5,
      })}\n`
    );
    writeFileSync(
      join(chitraDir, "b.jsonl"),
      `${JSON.stringify({
        ts: now,
        id: "chitra-1",
        model: "claude-opus-4-6",
        input_tokens: 200,
        output_tokens: 100,
        cost: 1.0,
      })}\n`
    );
    saveConfig(
      {
        ...DEFAULT_CONFIG,
        customSources: [
          { path: ribhuDir, format: "tokmeter-usage-jsonl", provider: "ribhu" },
          { path: chitraDir, format: "tokmeter-usage-jsonl", provider: "chitragupta" },
        ],
        modifiedBy: "user",
      },
      home
    );

    const ctx = { homeDir: home, pricing: new PricingService(), skipPricing: true };
    const records = await scanRawRecords(ctx, ["ribhu"], "today", []);
    expect(records).toHaveLength(1);
    expect(records[0].provider).toBe("ribhu");
    expect(records[0].apiCallId).toBe("ribhu-1");
  });

  it("updates scanMeta.unpricedModels and wishlist.json during refreshToday", async () => {
    const sessDir = join(home, ".custom-unpriced");
    mkdirSync(sessDir, { recursive: true });
    const file = join(sessDir, "today.jsonl");
    const t0 = Date.now() - 5_000;
    writeFileSync(
      file,
      `${JSON.stringify({
        ts: t0,
        id: "u-0",
        model: "known-seeded",
        input_tokens: 100,
        output_tokens: 20,
        cost: 0.25,
      })}\n`
    );
    saveConfig(
      {
        ...DEFAULT_CONFIG,
        customSources: [{ path: sessDir, format: "tokmeter-usage-jsonl", provider: "custom" }],
        modifiedBy: "user",
      },
      home
    );

    const core = new TokmeterCore({ homeDir: home });
    await core.scan({ today: true });
    expect(core.getScanMeta().unpricedModels).toEqual([]);
    const wishlistPath = join(home, ".tokmeter", "wishlist.json");
    expect(existsSync(wishlistPath)).toBe(false);

    // Append an unpriced model record after cold-start scan so refreshToday discovers it.
    const t1 = Date.now();
    writeFileSync(
      file,
      `${[
        JSON.stringify({
          ts: t0,
          id: "u-0",
          model: "known-seeded",
          input_tokens: 100,
          output_tokens: 20,
          cost: 0.25,
        }),
        JSON.stringify({
          ts: t1,
          id: "u-1",
          model: "mystery-new-model-999",
          input_tokens: 5_000,
          output_tokens: 1_000,
        }),
      ].join("\n")}\n`
    );

    await core.refreshToday(t1 + 100);
    expect(core.getScanMeta().unpricedModels).toEqual(["mystery-new-model-999"]);
    expect(core.getScanMeta().unpricedRecords).toBe(1);
    expect(existsSync(wishlistPath)).toBe(true);
    const wishlist = JSON.parse(readFileSync(wishlistPath, "utf-8")) as {
      models: Array<{ id: string; hits: number }>;
    };
    expect(wishlist.models[0]).toMatchObject({ id: "mystery-new-model-999", hits: 1 });
  });
});
