import type { ChartConfig } from "../components/ui/chart.js";

/**
 * The five token buckets core sums into `totalTokens`, in fixed palette order
 * (the order is what keeps adjacent stacked segments CVD-distinguishable).
 * `cacheWrite1hTokens` is a subset of cache writes and is never a bucket.
 */
export const TOKEN_BUCKETS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
] as const;

export type TokenBucket = (typeof TOKEN_BUCKETS)[number];

export const TOKEN_CONFIG: ChartConfig = {
  inputTokens: { label: "Input", color: "var(--series-1)" },
  outputTokens: { label: "Output", color: "var(--series-2)" },
  cacheReadTokens: { label: "Cache read", color: "var(--series-3)" },
  cacheWriteTokens: { label: "Cache write", color: "var(--series-4)" },
  reasoningTokens: { label: "Reasoning", color: "var(--series-5)" },
};

export const COST_CONFIG: ChartConfig = {
  cost: { label: "Est. cost", color: "var(--series-1)" },
};

export const TOKENS_TOTAL_CONFIG: ChartConfig = {
  totalTokens: { label: "Tokens", color: "var(--series-1)" },
};
