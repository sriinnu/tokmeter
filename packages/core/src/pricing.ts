/**
 * @sriinnu/tokmeter-core — Pricing bridge using @sriinnu/kosha-discovery.
 *
 * Resolves model pricing across 20+ AI providers. Resolution order:
 *
 *  1. In-memory cache
 *  2. User overrides (~/.tokmeter/pricing-overrides.json) — highest priority
 *     after the cache. Lets users encode private/enterprise/custom rates that
 *     no public catalog will ever know about.
 *  3. kosha direct — `registry.model(id)` resolves canonical IDs.
 *     Uses `originPricing` (direct-provider rate) when available, else `pricing`.
 *  4. kosha fuzzy — searches all discovered models with an exact-first scorer.
 *     Covers the long tail of providers automatically.
 *  5. null — no pricing available
 *
 * User-overrides JSON schema (~/.tokmeter/pricing-overrides.json):
 *
 *   {
 *     "claude-opus-4-7": { "inputPerMillion": 4, "outputPerMillion": 20 },
 *     "my-internal-deployment": {
 *       "inputPerMillion": 0,
 *       "outputPerMillion": 0,
 *       "cacheReadPerMillion": 0
 *     }
 *   }
 *
 * Keys are exact model ids. Values are partial ModelPricing objects
 * (input/output required; cache + reasoning fields optional). Missing
 * fields default to 0 — set them explicitly if your contract differs.
 *
 * Why kosha is the single source of truth (otherwise):
 *
 * Earlier versions of this file kept a hardcoded `STATIC_PRICING` table on top
 * of kosha. The original rationale was that some OpenRouter *proxy* prices
 * diverged from direct-API rates, and we wanted the direct rates. Since
 * kosha-discovery now sources its keyless catalog from models.dev (primary)
 * and LiteLLM (filler) — both of which publish *direct API* rates — that
 * rationale is gone. Worse, the static table started silently overriding
 * kosha with stale prices (e.g. Claude Opus 4.x was repriced from $15/$75
 * to $5/$25, but the static rows still said $15/$75 and prefix-matched
 * `claude-opus-4-7` to that stale row).
 *
 * One source of truth = no drift. kosha refreshes systematically; tokmeter
 * follows. User overrides are the only sanctioned escape hatch.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ModelPricing } from "@sriinnu/kosha-discovery";

// ─── Types ──────────────────────────────────────────────────────────

/**
 * Full pricing shape used internally — alias of kosha's ModelPricing including
 * reasoning fields. Kosha results are spread into this shape after resolution.
 */
type FullPricing = ModelPricing;

// Date suffixes used by various providers for versioned model IDs.
// Covers -20260402, -2026-04-02, -26-04-02, and -04-02. Providers are
// inconsistent (Claude uses -YYYYMMDD, Qwen proxies use -MM-DD, etc).
const DATE_SUFFIX_RE =
  /-(?:\d{8}|\d{4}-\d{2}-\d{2}|\d{2}-\d{2}-\d{2}|\d{2}-\d{2})$/;

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

/** Default freshness window — beyond this we lazily kick off a background refresh. */
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Fire-and-forget background refresh if the kosha registry is older than
 * `staleAfterMs`. The current call returns immediately — the refresh runs
 * asynchronously and the *next* scan benefits from the new data via the
 * mtime bump.
 *
 * Idempotent across concurrent callers: a single in-flight promise is
 * shared so multiple `maybeBackgroundRefresh()` calls within the same
 * process collapse into one network refresh.
 *
 * Safe to call on every scan — does nothing when the registry is fresh.
 */
let backgroundRefreshInFlight: Promise<void> | null = null;
export function maybeBackgroundRefresh(
  options: { staleAfterMs?: number; cacheDir?: string } = {},
): void {
  const staleAfter = options.staleAfterMs ?? STALE_AFTER_MS;
  const mtime = getKoshaRegistryMtime();
  if (mtime > 0 && Date.now() - mtime < staleAfter) return; // fresh
  if (backgroundRefreshInFlight) return; // already refreshing
  backgroundRefreshInFlight = refreshKoshaRegistry(options.cacheDir)
    .catch(() => {
      // Background refresh failures are non-fatal — the next scan still works
      // off whatever cache we have, and a manual `tokmeter update` can retry.
    })
    .finally(() => {
      backgroundRefreshInFlight = null;
    });
}

/** Path to the user-config pricing override file. */
function userOverridesPath(): string {
  return join(homedir(), ".tokmeter", "pricing-overrides.json");
}

/** mtime of the user-overrides file (0 if absent). */
function userOverridesMtime(): number {
  try {
    return statSync(userOverridesPath()).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * Read user-config pricing overrides if the file exists. Returns an empty map
 * on any error (missing file, malformed JSON, etc.) so a broken override file
 * never breaks pricing resolution.
 */
function loadUserOverrides(): Map<string, FullPricing> {
  const overrides = new Map<string, FullPricing>();
  try {
    const raw = readFileSync(userOverridesPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return overrides;
    for (const [id, pricing] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof id !== "string" || id.length === 0 || id.length > 256) continue;
      if (!pricing || typeof pricing !== "object") continue;
      const p = pricing as Record<string, unknown>;
      const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
      if (!isNum(p.inputPerMillion) || !isNum(p.outputPerMillion)) continue;
      const out: FullPricing = {
        inputPerMillion: p.inputPerMillion,
        outputPerMillion: p.outputPerMillion,
      };
      if (isNum(p.cacheReadPerMillion)) out.cacheReadPerMillion = p.cacheReadPerMillion;
      if (isNum(p.cacheWritePerMillion)) out.cacheWritePerMillion = p.cacheWritePerMillion;
      if (isNum(p.reasoningInputPerMillion)) out.reasoningInputPerMillion = p.reasoningInputPerMillion;
      if (isNum(p.reasoningOutputPerMillion)) out.reasoningOutputPerMillion = p.reasoningOutputPerMillion;
      overrides.set(id, out);
    }
  } catch {
    // missing or malformed — quietly fall through with empty map
  }
  return overrides;
}

/** Cached pricing lookup: modelId → FullPricing or null. */
export class PricingService {
  private cache = new Map<string, FullPricing | null>();
  private userOverrides = new Map<string, FullPricing>();
  private userOverridesMtime = 0;
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
    const overridesMtime = userOverridesMtime();
    if (
      this.initialized &&
      currentMtime === this.registryMtime &&
      overridesMtime === this.userOverridesMtime
    ) {
      return;
    }
    // Registry file or overrides changed (or first init) — drop stale lookups.
    if (this.initialized) this.cache.clear();
    try {
      const { createKosha } = await import("@sriinnu/kosha-discovery");
      this.registry = await createKosha(this.cacheDir ? { cacheDir: this.cacheDir } : undefined);
      this.pricingUnavailable = false;
    } catch {
      this.registry = null;
      this.pricingUnavailable = true;
    }
    this.userOverrides = loadUserOverrides();
    this.userOverridesMtime = overridesMtime;
    this.registryMtime = currentMtime;
    this.initialized = true;
  }

  /**
   * Seed the in-memory pricing cache for a specific model. Test seam used to
   * keep `calculateCost` regression tests hermetic without reaching into
   * private state. Production callers should not need this — kosha is the
   * source of truth.
   */
  seedPricing(modelId: string, pricing: FullPricing): void {
    this.cache.set(modelId, this.roundPricing(pricing));
  }

  /**
   * Get pricing for a model.
   *
   * Resolution order:
   *  1. In-memory cache
   *  2. User overrides (~/.tokmeter/pricing-overrides.json)
   *  3. kosha direct — `registry.model(id)` resolves canonical IDs;
   *     prefers `card.originPricing` (direct-provider rate) over `card.pricing`
   *  4. kosha fuzzy — exact-first search across all discovered models
   *  5. null
   */
  async getPricing(modelId: string): Promise<FullPricing | null> {
    if (this.cache.has(modelId)) return this.cache.get(modelId) ?? null;

    // Tier 2: user-config overrides (highest priority after the cache).
    const userOverride = this.userOverrides.get(modelId);
    if (userOverride) {
      this.cache.set(modelId, userOverride);
      return userOverride;
    }

    if (this.registry) {
      // Tier 2: kosha canonical lookup
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

      // Tier 3: fuzzy search for long-tail models
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
      // Gemini and DeepSeek charge ~25% for cached input, but kosha publishes
      // those explicit rates so this fallback only fires for genuinely-missing
      // cache rates — never overrides upstream data.
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
