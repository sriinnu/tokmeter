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

import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPricing } from "@sriinnu/kosha-discovery";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Full pricing shape used internally — extends kosha's ModelPricing with the
 * reasoning fields added in kosha 0.6.0. The static table uses these directly;
 * kosha results are spread into this shape after resolution.
 */
type FullPricing = ModelPricing;

// ─── Static pricing table ────────────────────────────────────────────
//
// All prices USD per million tokens. Longest-prefix match wins.
// reasoningInputPerMillion / reasoningOutputPerMillion: kosha 0.6.0 fields.

const STATIC_PRICING: Array<[prefix: string, pricing: FullPricing]> = [
  // ── Anthropic Claude 4.x ─────────────────────────────────────────
  [
    "claude-opus-4-6",
    {
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  ],
  [
    "claude-opus-4-5",
    {
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  ],
  [
    "claude-opus-4",
    {
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  ],
  [
    "claude-sonnet-4-6",
    {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  ],
  [
    "claude-sonnet-4-5",
    {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  ],
  [
    "claude-sonnet-4",
    {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  ],
  [
    "claude-haiku-4-5",
    {
      inputPerMillion: 0.8,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1,
    },
  ],
  [
    "claude-haiku-4",
    {
      inputPerMillion: 0.8,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1,
    },
  ],
  // ── Anthropic Claude 3.x ─────────────────────────────────────────
  [
    "claude-3-5-sonnet",
    {
      inputPerMillion: 3,
      outputPerMillion: 15,
      cacheReadPerMillion: 0.3,
      cacheWritePerMillion: 3.75,
    },
  ],
  [
    "claude-3-5-haiku",
    {
      inputPerMillion: 0.8,
      outputPerMillion: 4,
      cacheReadPerMillion: 0.08,
      cacheWritePerMillion: 1,
    },
  ],
  [
    "claude-3-opus",
    {
      inputPerMillion: 15,
      outputPerMillion: 75,
      cacheReadPerMillion: 1.5,
      cacheWritePerMillion: 18.75,
    },
  ],
  ["claude-3-sonnet", { inputPerMillion: 3, outputPerMillion: 15 }],
  ["claude-3-haiku", { inputPerMillion: 0.25, outputPerMillion: 1.25 }],
  // ── OpenAI GPT / O-series ────────────────────────────────────────
  // GPT-5 family resolves through kosha-discovery (OpenRouter mirror).
  // OpenAI caches at 50% of input (NOT 10% like Anthropic). Every OpenAI
  // model gets explicit cacheReadPerMillion to avoid the 10% universal
  // fallback undercharging by 5x.
  ["gpt-4o-mini", { inputPerMillion: 0.15, outputPerMillion: 0.6, cacheReadPerMillion: 0.075 }],
  ["gpt-4o", { inputPerMillion: 2.5, outputPerMillion: 10, cacheReadPerMillion: 1.25 }],
  ["gpt-4-turbo", { inputPerMillion: 10, outputPerMillion: 30, cacheReadPerMillion: 5 }],
  ["gpt-4", { inputPerMillion: 30, outputPerMillion: 60, cacheReadPerMillion: 15 }],
  ["gpt-3.5-turbo", { inputPerMillion: 0.5, outputPerMillion: 1.5, cacheReadPerMillion: 0.25 }],
  [
    "o4-mini",
    {
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
      cacheReadPerMillion: 0.55,
      reasoningInputPerMillion: 1.1,
      reasoningOutputPerMillion: 4.4,
    },
  ],
  [
    "o3-mini",
    {
      inputPerMillion: 1.1,
      outputPerMillion: 4.4,
      cacheReadPerMillion: 0.55,
      reasoningInputPerMillion: 1.1,
      reasoningOutputPerMillion: 4.4,
    },
  ],
  [
    "o3",
    {
      inputPerMillion: 10,
      outputPerMillion: 40,
      cacheReadPerMillion: 5,
      reasoningInputPerMillion: 10,
      reasoningOutputPerMillion: 40,
    },
  ],
  [
    "o1-mini",
    {
      inputPerMillion: 3,
      outputPerMillion: 12,
      cacheReadPerMillion: 1.5,
      reasoningInputPerMillion: 3,
      reasoningOutputPerMillion: 12,
    },
  ],
  [
    "o1",
    {
      inputPerMillion: 15,
      outputPerMillion: 60,
      cacheReadPerMillion: 7.5,
      reasoningInputPerMillion: 15,
      reasoningOutputPerMillion: 60,
    },
  ],
  // ── Google Gemini ─────────────────────────────────────────────────
  // Gemini caches at ~25% of input rate (NOT 10% like OpenAI/Anthropic).
  // Explicit cacheReadPerMillion entries prevent the universal 10% fallback
  // from undercharging Gemini sessions.
  [
    "gemini-2.5-pro",
    {
      inputPerMillion: 1.25,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.31, // 25% of input
    },
  ],
  [
    "gemini-2.5-flash",
    {
      inputPerMillion: 0.15,
      outputPerMillion: 0.6,
      cacheReadPerMillion: 0.0375, // 25% of input
      reasoningInputPerMillion: 3.5,
      reasoningOutputPerMillion: 3.5,
    },
  ],
  ["gemini-2.0-flash", { inputPerMillion: 0.1, outputPerMillion: 0.4, cacheReadPerMillion: 0.025 }],
  ["gemini-1.5-pro", { inputPerMillion: 1.25, outputPerMillion: 5, cacheReadPerMillion: 0.3125 }],
  [
    "gemini-1.5-flash",
    { inputPerMillion: 0.075, outputPerMillion: 0.3, cacheReadPerMillion: 0.01875 },
  ],
  ["gemini-pro", { inputPerMillion: 0.125, outputPerMillion: 0.375 }],
  // ── DeepSeek ──────────────────────────────────────────────────────
  // DeepSeek caches at ~26% of input rate ($0.07/M cached vs $0.27/M input).
  [
    "deepseek-reasoner",
    {
      inputPerMillion: 0.55,
      outputPerMillion: 2.19,
      cacheReadPerMillion: 0.14,
      reasoningInputPerMillion: 0.55,
      reasoningOutputPerMillion: 2.19,
    },
  ],
  [
    "deepseek-r1",
    {
      inputPerMillion: 0.55,
      outputPerMillion: 2.19,
      cacheReadPerMillion: 0.14,
      reasoningInputPerMillion: 0.55,
      reasoningOutputPerMillion: 2.19,
    },
  ],
  ["deepseek-v3", { inputPerMillion: 0.27, outputPerMillion: 1.1, cacheReadPerMillion: 0.07 }],
  ["deepseek-chat", { inputPerMillion: 0.27, outputPerMillion: 1.1, cacheReadPerMillion: 0.07 }],
  ["deepseek-coder", { inputPerMillion: 0.27, outputPerMillion: 1.1, cacheReadPerMillion: 0.07 }],
  // ── xAI Grok ─────────────────────────────────────────────────────
  ["grok-4", { inputPerMillion: 3, outputPerMillion: 15 }],
  [
    "grok-3-mini",
    {
      inputPerMillion: 0.3,
      outputPerMillion: 0.5,
      reasoningInputPerMillion: 0.3,
      reasoningOutputPerMillion: 0.5,
    },
  ],
  ["grok-3", { inputPerMillion: 3, outputPerMillion: 15 }],
  ["grok-2", { inputPerMillion: 2, outputPerMillion: 10 }],
  // ── Mistral ───────────────────────────────────────────────────────
  ["codestral", { inputPerMillion: 0.2, outputPerMillion: 0.6 }],
  ["mistral-large", { inputPerMillion: 2, outputPerMillion: 6 }],
  ["mistral-medium", { inputPerMillion: 0.4, outputPerMillion: 2 }],
  ["mistral-small", { inputPerMillion: 0.1, outputPerMillion: 0.3 }],
  ["mistral-7b", { inputPerMillion: 0.025, outputPerMillion: 0.025 }],
  ["mixtral-8x22b", { inputPerMillion: 2, outputPerMillion: 6 }],
  ["mixtral-8x7b", { inputPerMillion: 0.65, outputPerMillion: 0.65 }],
  // ── Moonshot / Kimi ──────────────────────────────────────────────
  ["kimi-k2", { inputPerMillion: 0.15, outputPerMillion: 2.5 }],
  ["kimi-k1", { inputPerMillion: 0.15, outputPerMillion: 2.5 }],
  ["moonshot-v1-128k", { inputPerMillion: 24, outputPerMillion: 24 }],
  ["moonshot-v1-32k", { inputPerMillion: 24, outputPerMillion: 24 }],
  ["moonshot-v1-8k", { inputPerMillion: 12, outputPerMillion: 12 }],
  // ── Meta Llama ────────────────────────────────────────────────────
  ["llama-4-maverick", { inputPerMillion: 0.18, outputPerMillion: 0.6 }],
  ["llama-4-scout", { inputPerMillion: 0.08, outputPerMillion: 0.3 }],
  ["llama-3.3-70b", { inputPerMillion: 0.23, outputPerMillion: 0.4 }],
  ["llama-3.1-405b", { inputPerMillion: 4, outputPerMillion: 4 }],
  ["llama-3.1-70b", { inputPerMillion: 0.23, outputPerMillion: 0.4 }],
  ["llama-3.1-8b", { inputPerMillion: 0.05, outputPerMillion: 0.1 }],
  ["llama-3-70b", { inputPerMillion: 0.23, outputPerMillion: 0.4 }],
  ["llama-3-8b", { inputPerMillion: 0.05, outputPerMillion: 0.1 }],
  // ── Cohere ────────────────────────────────────────────────────────
  ["command-a", { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ["command-r-plus", { inputPerMillion: 2.5, outputPerMillion: 10 }],
  ["command-r", { inputPerMillion: 0.15, outputPerMillion: 0.6 }],
  // ── Perplexity ───────────────────────────────────────────────────
  ["sonar-pro", { inputPerMillion: 3, outputPerMillion: 15 }],
  [
    "sonar-reasoning",
    {
      inputPerMillion: 1,
      outputPerMillion: 5,
      reasoningInputPerMillion: 1,
      reasoningOutputPerMillion: 5,
    },
  ],
  ["sonar", { inputPerMillion: 1, outputPerMillion: 1 }],
];

// Sorted once at module load — longest prefix wins
const SORTED_STATIC = STATIC_PRICING.slice().sort((a, b) => b[0].length - a[0].length);

// Covers -20260402, -2026-04-02, -26-04-02, and -04-02. Providers are
// inconsistent (Claude uses -YYYYMMDD, Qwen proxies use -MM-DD, etc).
const DATE_SUFFIX_RE =
  /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2}|\d{2}-\d{2})$/;

/**
 * Resolve static pricing for a model ID by longest-prefix match.
 * Strips any recognizable date suffix before matching.
 */
function staticPricing(modelId: string): FullPricing | null {
  const id = modelId.toLowerCase().replace(DATE_SUFFIX_RE, "");
  for (const [prefix, pricing] of SORTED_STATIC) {
    if (id.startsWith(prefix)) return pricing;
  }
  return null;
}

// ─── PricingService ──────────────────────────────────────────────────

/**
 * Freshness signal for the kosha pricing registry.
 *
 * Kosha writes two things on discovery:
 *   1. `~/.kosha/registry.json` — the canonical manifest, rewritten only when
 *      the aggregated snapshot actually changes content
 *   2. `~/.kosha/cache/provider_*.json` — per-provider caches, always rewritten
 *      on discovery runs even if content is unchanged
 *
 * We take the max of the manifest mtime and the cache directory mtime so a
 * refresh (via `kosha-update` or the `kosha` CLI) always bumps the signal,
 * even when the manifest itself happens to be byte-identical.
 */
export function getKoshaRegistryMtime(): number {
  const home = homedir();
  let maxMtime = 0;
  try {
    const manifest = statSync(join(home, ".kosha", "registry.json")).mtimeMs;
    if (manifest > maxMtime) maxMtime = manifest;
  } catch {}
  try {
    const cacheDir = statSync(join(home, ".kosha", "cache")).mtimeMs;
    if (cacheDir > maxMtime) maxMtime = cacheDir;
  } catch {}
  return maxMtime;
}

/**
 * Force kosha-discovery to rerun discovery against upstream providers and
 * overwrite `~/.kosha/registry.json` with the latest model + pricing data.
 *
 * Tokmeter's scan cache will notice the mtime bump on the next scan and
 * reprice today's records automatically.
 */
export async function refreshKoshaRegistry(cacheDir?: string): Promise<void> {
  const { createKosha } = await import("@sriinnu/kosha-discovery");
  const registry = (await createKosha(cacheDir ? { cacheDir } : undefined)) as unknown as {
    refresh: (providerId?: string) => Promise<void>;
  };
  await registry.refresh();
}

/** Cached pricing lookup: modelId → FullPricing or null. */
export class PricingService {
  private cache = new Map<string, FullPricing | null>();
  private registry: any = null;
  private initialized = false;
  private cacheDir?: string;
  private registryMtime = 0;

  /** True if kosha-discovery failed to load (e.g. not installed). */
  public pricingUnavailable = false;

  constructor(cacheDir?: string) {
    this.cacheDir = cacheDir;
  }

  /**
   * mtime of ~/.kosha/registry.json observed at the last successful init.
   * Consumers (e.g. the record cache and statusline) use this to decide
   * whether previously-priced records need to be repriced.
   */
  getRegistryMtime(): number {
    return this.registryMtime;
  }

  /**
   * Initialize the kosha-discovery registry. Safe to call repeatedly — if the
   * registry file has been updated since the last init, the in-memory lookup
   * cache is cleared so the next `getPricing()` call returns fresh rates.
   */
  async init(): Promise<void> {
    const currentMtime = getKoshaRegistryMtime();
    if (this.initialized && currentMtime === this.registryMtime) return;
    // Registry file changed (or first init) — drop stale lookups.
    if (this.initialized && currentMtime !== this.registryMtime) {
      this.cache.clear();
    }
    try {
      const { createKosha } = await import("@sriinnu/kosha-discovery");
      this.registry = await createKosha(this.cacheDir ? { cacheDir: this.cacheDir } : undefined);
      this.pricingUnavailable = false;
    } catch {
      this.registry = null;
      this.pricingUnavailable = true;
    }
    this.registryMtime = currentMtime;
    this.initialized = true;
  }

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
  async getPricing(modelId: string): Promise<FullPricing | null> {
    if (this.cache.has(modelId)) return this.cache.get(modelId) ?? null;

    // Tier 2: static table (accurate direct-API pricing)
    const stat = staticPricing(modelId);
    if (stat) {
      this.cache.set(modelId, stat);
      return stat;
    }

    if (this.registry) {
      // Tier 3: kosha canonical lookup (works for all major models since 0.6.0)
      try {
        const card = this.registry.model(modelId) as
          | {
              pricing?: ModelPricing;
              originPricing?: ModelPricing;
            }
          | undefined;
        // originPricing = direct-provider rate on proxied routes (preferred)
        const raw = card?.originPricing ?? card?.pricing;
        // Reject zero-priced hits — kosha's canonical resolver sometimes maps
        // a bare ID to a `:free` variant, which would silently bill at $0.
        // Fall through to fuzzy so we can find the paid variant.
        if (raw && raw.inputPerMillion > 0 && raw.outputPerMillion > 0) {
          const p = this.roundPricing(raw);
          this.cache.set(modelId, p);
          return p;
        }
      } catch {
        // not found
      }

      // Tier 4: fuzzy search for long-tail models not in static table
      try {
        const fuzzy = this.koshaFuzzySearch(modelId);
        if (fuzzy) {
          this.cache.set(modelId, fuzzy);
          return fuzzy;
        }
      } catch {
        // fuzzy search failed
      }
    }

    this.cache.set(modelId, null);
    return null;
  }

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
  async calculateCost(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
    cacheReadTokens = 0,
    cacheWriteTokens = 0,
    reasoningTokens = 0
  ): Promise<number> {
    const pricing = await this.getPricing(modelId);
    if (!pricing) return 0;

    const perToken = (perMillion: number) => perMillion / 1_000_000;

    let cost = 0;
    cost += inputTokens * perToken(pricing.inputPerMillion);
    cost += outputTokens * perToken(pricing.outputPerMillion);
    if (cacheReadTokens) {
      // Both OpenAI and Anthropic price cached input at ~10% of full input rate.
      // Fall back to that ratio if the resolver didn't supply an explicit rate.
      // Gemini and DeepSeek have explicit ~25% rates in the static table — they
      // don't fall back here so they aren't undercharged.
      const cacheRate = pricing.cacheReadPerMillion ?? pricing.inputPerMillion * 0.1;
      cost += cacheReadTokens * perToken(cacheRate);
    }
    if (cacheWriteTokens && pricing.cacheWritePerMillion) {
      // Cache writes only fire when an explicit rate exists. Anthropic has them
      // (1.25× input). OpenAI/Gemini don't charge for cache writes — caching is
      // free or implicit, only reads are discounted. We don't synthesize a
      // fallback because the wrong default would silently overcharge.
      cost += cacheWriteTokens * perToken(pricing.cacheWritePerMillion);
    }
    if (reasoningTokens) {
      // Use reasoning-specific rates if available (kosha 0.6.0+), else output rate
      const reasoningRate =
        pricing.reasoningOutputPerMillion ??
        pricing.reasoningInputPerMillion ??
        pricing.outputPerMillion;
      cost += reasoningTokens * perToken(reasoningRate);
    }
    return cost;
  }

  /** Clear the in-memory pricing cache. */
  clearCache(): void {
    this.cache.clear();
  }

  // ── Private ───────────────────────────────────────────────────────

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
  private koshaFuzzySearch(modelId: string): FullPricing | null {
    const normalized = modelId
      .toLowerCase()
      .replace(DATE_SUFFIX_RE, "")
      .replace(/-latest$/, "")
      .replace(/\./g, "-");

    interface KoshaModel {
      id: string;
      pricing?: ModelPricing;
      originPricing?: ModelPricing;
      provider?: string;
    }
    const all: KoshaModel[] = this.registry.models();

    const best = all
      .filter((m) => {
        const eff = m.originPricing ?? m.pricing;
        if (!eff || eff.inputPerMillion <= 0 || eff.outputPerMillion <= 0) return false;
        const lower = m.id.toLowerCase();
        if (lower.includes(":free") || lower.includes(":exacto")) return false;
        const mNorm = lower.replace(/\./g, "-");
        return mNorm.includes(normalized) || mNorm.split("/").pop()?.includes(normalized) === true;
      })
      .sort((a, b) => {
        const aBase = a.id.toLowerCase().replace(/\./g, "-").split("/").pop() ?? "";
        const bBase = b.id.toLowerCase().replace(/\./g, "-").split("/").pop() ?? "";
        const score = (base: string) =>
          base === normalized ? 2 : base.startsWith(normalized) ? 1 : 0;
        const diff = score(bBase) - score(aBase);
        if (diff !== 0) return diff;
        return aBase.length - bBase.length;
      })[0];

    const eff = best?.originPricing ?? best?.pricing;
    return eff ? this.roundPricing(eff) : null;
  }

  /**
   * Round all pricing fields to 6 decimal places to eliminate float noise.
   * Returns null if any required field is NaN or Infinity (treat as unpriced).
   */
  private roundPricing(p: ModelPricing): FullPricing | null {
    const r = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
    // Guard: if any field is NaN or Infinity, bail — this model is unpriced.
    const allValues = [
      p.inputPerMillion,
      p.outputPerMillion,
      p.cacheReadPerMillion,
      p.cacheWritePerMillion,
      p.reasoningInputPerMillion,
      p.reasoningOutputPerMillion,
    ];
    for (const v of allValues) {
      if (v !== undefined && !Number.isFinite(v)) return null;
    }
    return {
      inputPerMillion: r(p.inputPerMillion),
      outputPerMillion: r(p.outputPerMillion),
      ...(p.cacheReadPerMillion ? { cacheReadPerMillion: r(p.cacheReadPerMillion) } : {}),
      ...(p.cacheWritePerMillion ? { cacheWritePerMillion: r(p.cacheWritePerMillion) } : {}),
      ...(p.reasoningInputPerMillion
        ? { reasoningInputPerMillion: r(p.reasoningInputPerMillion) }
        : {}),
      ...(p.reasoningOutputPerMillion
        ? { reasoningOutputPerMillion: r(p.reasoningOutputPerMillion) }
        : {}),
    };
  }
}
