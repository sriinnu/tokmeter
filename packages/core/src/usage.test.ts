import { describe, expect, test } from "vitest";
import type { TokenRecord } from "./types.js";
import { deriveUsage, sumUsage } from "./usage.js";

function r(overrides: Partial<TokenRecord>): TokenRecord {
  return {
    timestamp: 0,
    project: "demo",
    provider: "claude-code",
    model: "claude-sonnet-4-5",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    ...overrides,
  };
}

describe("deriveUsage", () => {
  test("calculates cache rates from canonical input buckets", () => {
    const usage = deriveUsage({
      inputTokens: 500,
      cacheReadTokens: 8_000,
      cacheWriteTokens: 1_500,
      outputTokens: 503,
      reasoningTokens: 0,
    });

    expect(usage.totalInputTokens).toBe(10_000);
    expect(usage.freshInputTokens).toBe(2_000);
    expect(usage.cacheHitRate).toBeCloseTo(0.8, 5);
    expect(usage.cacheMissRate).toBeCloseTo(0.05, 5);
    expect(usage.freshInputShare).toBeCloseTo(0.2, 5);
    expect(usage.cacheReadShare).toBeCloseTo(8_000 / 8_500, 5);
    expect(usage.cacheWriteShare).toBeCloseTo(0.15, 5);
    expect(usage.hasCacheTelemetry).toBe(true);
  });

  test("estimates visible output when reasoning is a reported sub-bucket", () => {
    const usage = deriveUsage({
      inputTokens: 75,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1_186,
      reasoningTokens: 1_024,
    });

    expect(usage.visibleOutputTokensApprox).toBe(162);
    expect(usage.ledgerTotalTokens).toBe(2_285);
  });
});

describe("sumUsage", () => {
  test("aggregates any provider's canonical buckets before deriving rates", () => {
    const usage = sumUsage([
      r({ provider: "codex", inputTokens: 20, cacheReadTokens: 80, outputTokens: 10 }),
      r({ provider: "claude-code", inputTokens: 5, cacheWriteTokens: 15, outputTokens: 2 }),
    ]);

    expect(usage.totalInputTokens).toBe(120);
    expect(usage.cacheHitRate).toBeCloseTo(80 / 120, 5);
    expect(usage.freshInputTokens).toBe(40);
    expect(usage.outputTokens).toBe(12);
  });
});
