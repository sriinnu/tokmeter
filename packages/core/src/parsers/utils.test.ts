import { describe, expect, test } from "vitest";
import { ALL_PROVIDER_IDS } from "./index.js";
import { createRecord } from "./utils.js";

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
