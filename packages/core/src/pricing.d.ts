/**
 * @sriinnu/tokmeter-core — Pricing bridge using @sriinnu/kosha-discovery with static fallback.
 *
 * Resolves model pricing across 20+ AI providers. Resolution order:
 *
 * 1. In-memory cache
 * 2. Static table — hardcoded direct-API pricing for major known models.
 *    Prefix-matched so "claude-opus-4-6-20260401" → "claude-opus-4-6".
 *    Stays ahead of kosha because some OpenRouter proxy prices differ from
 *    direct-API rates (e.g. Claude Opus 3× cheaper on OpenRouter).
 * 3. kosha direct — `registry.model(id)` now resolves canonical IDs since 0.6.0.
 *    Uses `originPricing` (direct-provider rate) when available, else `pricing`.
 * 4. kosha fuzzy — searches 300+ OpenRouter models with an exact-first scorer.
 *    Covers the long tail of providers automatically.
 * 5. null — no pricing available
 *
 * Static pricing sources (as of 2025-07):
 *   Anthropic  — https://www.anthropic.com/pricing
 *   OpenAI     — https://openai.com/api/pricing
 *   Google     — https://ai.google.dev/gemini-api/docs/pricing
 *   DeepSeek   — https://api-docs.deepseek.com/quick_start/pricing
 *   xAI (Grok) — https://x.ai/api
 *   Mistral    — https://mistral.ai/technology/#pricing
 *   Meta Llama — via Groq/Fireworks reference pricing
 *   Moonshot   — https://platform.moonshot.cn/docs/pricing
 */
import type { ModelPricing } from "@sriinnu/kosha-discovery";
/**
 * Full pricing shape used internally — extends kosha's ModelPricing with the
 * reasoning fields added in kosha 0.6.0. The static table uses these directly;
 * kosha results are spread into this shape after resolution.
 */
type FullPricing = ModelPricing;
/** Cached pricing lookup: modelId → FullPricing or null. */
export declare class PricingService {
  private cache;
  private registry;
  private initialized;
  private cacheDir?;
  /** True if kosha-discovery failed to load (e.g. not installed). */
  pricingUnavailable: boolean;
  constructor(cacheDir?: string);
  /** Initialize the kosha-discovery registry (idempotent). */
  init(): Promise<void>;
  /**
   * Get pricing for a model.
   *
   * Resolution order:
   * 1. In-memory cache
   * 2. Static table — accurate direct-API rates; avoids proxy markup on known models
   * 3. kosha direct — `registry.model(id)` resolves canonical IDs since 0.6.0;
   *    prefers `card.originPricing` (direct-provider rate) over `card.pricing`
   * 4. kosha fuzzy — exact-first search across 300+ discovered models
   * 5. null
   */
  getPricing(modelId: string): Promise<FullPricing | null>;
  /**
   * Calculate the USD cost for a token usage breakdown.
   *
   * Handles both `reasoningInputPerMillion`/`reasoningOutputPerMillion` (kosha 0.6.0)
   * and falls back to `outputPerMillion` when no dedicated reasoning rate exists.
   *
   * @param modelId          - Model identifier (e.g. "claude-sonnet-4-6-20250514").
   * @param inputTokens      - Standard input tokens.
   * @param outputTokens     - Output tokens generated.
   * @param cacheReadTokens  - Tokens served from prompt cache.
   * @param cacheWriteTokens - Tokens written to prompt cache.
   * @param reasoningTokens  - Thinking/reasoning tokens (input + output combined).
   * @returns Cost in USD, or 0 if no pricing is available.
   */
  calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens?: number,
    cacheWriteTokens?: number,
    reasoningTokens?: number
  ): Promise<number>;
  /** Clear the in-memory pricing cache. */
  clearCache(): void;
  /**
   * Fuzzy-search kosha's discovered models for the best match.
   *
   * Scoring (best first):
   * - Skips :free / :exacto variants and zero-priced models
   * - Prefers `originPricing` (direct-provider rate) over `pricing`
   * - Exact base-ID match beats prefix match beats substring
   * - Shorter base IDs preferred (less decorated)
   * - Normalizes hyphens↔dots, strips date and "-latest" suffixes
   */
  private koshaFuzzySearch;
  /**
   * Round all pricing fields to 6 decimal places to eliminate float noise.
   * Returns null if any required field is NaN or Infinity (treat as unpriced).
   */
  private roundPricing;
}
