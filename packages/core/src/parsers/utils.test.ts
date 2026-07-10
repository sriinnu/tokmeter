import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { configFilePath } from "../config-service.js";
import { ALL_PROVIDER_IDS } from "./index.js";
import { createRecord, getConfiguredProviderPaths, mapWithConcurrency } from "./utils.js";

describe("mapWithConcurrency", () => {
  test("preserves input order regardless of completion order", async () => {
    // The codex scan zips newest[i] back to allFiles[i], so out-of-order results
    // would drop/keep the WRONG files. Make later items resolve first.
    const items = [0, 1, 2, 3, 4, 5];
    const out = await mapWithConcurrency(items, 3, async (n) => {
      await new Promise((r) => setTimeout(r, (items.length - n) * 3));
      return n * 10;
    });
    expect(out).toEqual([0, 10, 20, 30, 40, 50]);
  });

  test("empty input returns empty, fn never called", async () => {
    let calls = 0;
    const out = await mapWithConcurrency([], 4, async (x) => {
      calls++;
      return x;
    });
    expect(out).toEqual([]);
    expect(calls).toBe(0);
  });

  test("limit larger than length still maps every item", async () => {
    const out = await mapWithConcurrency([1, 2, 3], 100, async (n) => n + 1);
    expect(out).toEqual([2, 3, 4]);
  });

  test("never exceeds the concurrency limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async (n) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 2));
        inFlight--;
        return n;
      }
    );
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1); // actually ran concurrently
  });
});

describe("createRecord usage provenance", () => {
  test("attaches provenance metadata for every registered provider", () => {
    for (const provider of ALL_PROVIDER_IDS) {
      const record = createRecord({
        timestamp: 0,
        provider,
        model: "test-model",
      });

      expect(record.usage?.source).toBeTruthy();
      expect(record.usage?.inputTokens).toBeTruthy();
      expect(record.usage?.outputTokens).toBeTruthy();
      expect(record.usage?.cacheReadTokens).toBeTruthy();
      expect(record.usage?.cacheWriteTokens).toBeTruthy();
      expect(record.usage?.reasoningTokens).toBeTruthy();
      expect(record.usage?.cost).toBeTruthy();
    }
  });

  test("pins provider-family provenance defaults", () => {
    expect(createRecord({ timestamp: 0, provider: "codex", model: "gpt" }).usage).toMatchObject({
      source: "tool_jsonl",
      inputTokens: "normalized",
      cacheWriteTokens: "not_exposed",
      reasoningTokens: "direct",
      cost: "calculated",
    });

    expect(createRecord({ timestamp: 0, provider: "gemini", model: "gemini" }).usage).toMatchObject(
      {
        source: "tool_json",
        inputTokens: "normalized",
        reasoningTokens: "direct",
      }
    );

    expect(
      createRecord({ timestamp: 0, provider: "opencode", model: "model" }).usage
    ).toMatchObject({
      source: "tool_sqlite",
      reasoningTokens: "direct",
      cost: "calculated",
    });

    expect(createRecord({ timestamp: 0, provider: "cursor", model: "model" }).usage).toMatchObject({
      source: "tool_csv",
      cacheReadTokens: "not_exposed",
      cacheWriteTokens: "not_exposed",
      reasoningTokens: "not_exposed",
      cost: "calculated",
    });
  });

  test("allows parsers to override source format for provider fallbacks", () => {
    const record = createRecord({
      timestamp: 0,
      provider: "opencode",
      model: "test-model",
      usage: { source: "tool_json" },
    });

    expect(record.usage?.source).toBe("tool_json");
    expect(record.usage?.inputTokens).toBe("direct");
  });
});

describe("getConfiguredProviderPaths", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "get-configured-provider-paths-test-"));
  });

  afterEach(() => {
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  test("returns [] when no config file exists", () => {
    expect(getConfiguredProviderPaths("antigravity", tmpDir)).toEqual([]);
  });

  test("returns the configured paths for a provider that has them", () => {
    mkdirSync(join(tmpDir, ".tokmeter"), { recursive: true });
    writeFileSync(
      configFilePath(tmpDir),
      JSON.stringify({
        version: 1,
        providerPaths: { antigravity: ["~/custom/antigravity-ide", "/opt/other-install"] },
      })
    );

    expect(getConfiguredProviderPaths("antigravity", tmpDir)).toEqual([
      "~/custom/antigravity-ide",
      "/opt/other-install",
    ]);
    // A provider with no entry gets [], not the antigravity list or an error.
    expect(getConfiguredProviderPaths("cursor", tmpDir)).toEqual([]);
  });

  test("returns [] rather than throwing when config.json is malformed", () => {
    mkdirSync(join(tmpDir, ".tokmeter"), { recursive: true });
    writeFileSync(configFilePath(tmpDir), "{not valid json");

    expect(getConfiguredProviderPaths("antigravity", tmpDir)).toEqual([]);
  });
});
