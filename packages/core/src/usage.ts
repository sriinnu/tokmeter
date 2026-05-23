/**
 * @sriinnu/tokmeter-core - canonical usage math.
 *
 * TokenRecord keeps the factual ledger buckets. This module derives rates and
 * "what does this mean?" totals without changing the underlying record shape.
 */

import type { TokenRecord } from "./types.js";

export interface UsageBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface DerivedUsage {
  /** Canonical non-cache-read input. */
  uncachedInputTokens: number;
  /** Input that had to be processed freshly: uncached input + cache writes. */
  freshInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** input + cacheRead + cacheWrite. */
  totalInputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  /**
   * Best-effort visible output estimate when reasoning is reported as an
   * output sub-bucket by the upstream provider.
   */
  visibleOutputTokensApprox?: number;
  /**
   * Mechanical sum of Tokmeter's ledger buckets. Some providers report
   * reasoning as a sub-bucket of output, so this is for internal continuity,
   * not a claim that every bucket is mutually exclusive.
   */
  ledgerTotalTokens: number;
  /** cacheRead / (input + cacheRead + cacheWrite). */
  cacheHitRate: number;
  /** uncached input / (input + cacheRead + cacheWrite). */
  cacheMissRate: number;
  /** freshInput / (input + cacheRead + cacheWrite). */
  freshInputShare: number;
  /** cacheRead / (input + cacheRead), kept for legacy UI comparisons. */
  cacheReadShare: number;
  /** cacheWrite / (input + cacheRead + cacheWrite). */
  cacheWriteShare: number;
  hasCacheTelemetry: boolean;
}

function positive(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function deriveUsage(breakdown: UsageBreakdown): DerivedUsage {
  const uncachedInputTokens = positive(breakdown.inputTokens);
  const outputTokens = positive(breakdown.outputTokens);
  const cacheReadTokens = positive(breakdown.cacheReadTokens);
  const cacheWriteTokens = positive(breakdown.cacheWriteTokens);
  const reasoningTokens = positive(breakdown.reasoningTokens);

  const freshInputTokens = uncachedInputTokens + cacheWriteTokens;
  const totalInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;
  const legacyReadDenominator = uncachedInputTokens + cacheReadTokens;
  const ledgerTotalTokens =
    uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;

  return {
    uncachedInputTokens,
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalInputTokens,
    outputTokens,
    reasoningTokens,
    visibleOutputTokensApprox:
      reasoningTokens > 0 ? Math.max(0, outputTokens - reasoningTokens) : undefined,
    ledgerTotalTokens,
    cacheHitRate: totalInputTokens > 0 ? cacheReadTokens / totalInputTokens : 0,
    cacheMissRate: totalInputTokens > 0 ? uncachedInputTokens / totalInputTokens : 0,
    freshInputShare: totalInputTokens > 0 ? freshInputTokens / totalInputTokens : 0,
    cacheReadShare: legacyReadDenominator > 0 ? cacheReadTokens / legacyReadDenominator : 0,
    cacheWriteShare: totalInputTokens > 0 ? cacheWriteTokens / totalInputTokens : 0,
    hasCacheTelemetry: cacheReadTokens > 0 || cacheWriteTokens > 0,
  };
}

export function sumUsage(records: TokenRecord[]): DerivedUsage {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;

  for (const record of records) {
    inputTokens += record.inputTokens;
    outputTokens += record.outputTokens;
    cacheReadTokens += record.cacheReadTokens;
    cacheWriteTokens += record.cacheWriteTokens;
    reasoningTokens += record.reasoningTokens;
  }

  return deriveUsage({
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  });
}
