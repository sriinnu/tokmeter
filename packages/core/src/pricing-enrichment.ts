/**
 * @sriinnu/tokmeter-core — Cost enrichment for parsed records.
 *
 * Walks an array of TokenRecords with `cost === 0` and asks the pricing
 * service to fill them in. Records whose model has no entry in kosha stay
 * at $0 — the calling code treats that as a "silent $0" signal and tracks
 * it in {@link UnpricedTracker} for the kosha wishlist + amber-pill UI.
 *
 * The opaque-models set ({@link OPAQUE_MODELS}) carves out provider-side
 * routers that intentionally hide the underlying billed model — these stay
 * at $0 without polluting the unpriced signal.
 */

import type { PricingService } from "./pricing.js";
import type { ScanWarning, TokenRecord } from "./types.js";

/**
 * Models whose provider intentionally hides the underlying routed model, so
 * we can't price them even with a fresh kosha. Treat these as known-opaque:
 * cost still resolves to $0 (we honestly don't know), but suppress the
 * unpriced-leak signal — otherwise the bar's amber pill cries wolf on every
 * scan and the kosha wishlist begs for an entry that will never exist.
 *
 * Codex CLI's auto-review pipeline ("codex-auto-review") is the canonical
 * case: codex writes this literal string into rollout JSONL when OpenAI's
 * batched code-review router picks a model. The real model never surfaces
 * to the client. Add new entries here only when the same condition holds —
 * provider explicitly opaque, not just "kosha doesn't have it yet."
 */
export const OPAQUE_MODELS: ReadonlySet<string> = new Set(["codex-auto-review"]);

export function isOpaqueModel(model: string): boolean {
  return OPAQUE_MODELS.has(model);
}

export interface UnpricedTracker {
  models: Set<string>;
  records: number;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Enrich records that lack a cost with pricing data from kosha-discovery.
 *
 * Only processes records where `cost === 0`. Each record's cost is
 * calculated based on its model's per-million-token pricing for all
 * five token types: input, output, cache read, cache write, reasoning.
 *
 * Records whose model has no pricing entry will remain at cost 0.
 * Consumers should treat `cost === 0 && (inputTokens + outputTokens) > 0`
 * as a signal that pricing data was unavailable.
 */
export async function enrichCosts(
  records: TokenRecord[],
  pricing: PricingService,
  warningScope: "history" | "today",
  warnings: ScanWarning[],
  unpricedTracker?: UnpricedTracker
): Promise<void> {
  const costPromises = records.map(async (r) => {
    if (r.cost > 0) return;
    try {
      r.cost = await pricing.calculateCost(
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.reasoningTokens
      );
      const hasBillableTokens =
        r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheWriteTokens +
          r.reasoningTokens >
        0;
      const pricingUnavailable =
        r.cost === 0 &&
        hasBillableTokens &&
        !pricing.hasUserOverride(r.model) &&
        !isOpaqueModel(r.model);
      if (r.usage) {
        r.usage.cost = pricingUnavailable ? "not_exposed" : "calculated";
      }
      // Silent $0: pricing returned null, calculateCost returned 0, but the
      // record has real token usage. Track so the UI can surface it instead
      // of letting it disappear into the totals. Skip the track when the
      // user has an explicit override for this model — a $0 entry there
      // means "intentionally free" (internal/local/negotiated deployment),
      // not a lookup miss, and we'd otherwise flood the amber pill with
      // every internal model the user has configured.
      if (unpricedTracker && pricingUnavailable) {
        unpricedTracker.models.add(r.model);
        unpricedTracker.records += 1;
      }
    } catch (error) {
      if (r.usage) r.usage.cost = "not_exposed";
      warnings.push({
        scope: warningScope,
        message: `Pricing lookup failed for ${r.model} — leaving cost at $0 (${toErrorMessage(error)}).`,
      });
      if (unpricedTracker && !isOpaqueModel(r.model)) {
        unpricedTracker.models.add(r.model);
        unpricedTracker.records += 1;
      }
    }
  });
  await Promise.all(costPromises);
}

export function markPricingSkipped(records: TokenRecord[]): void {
  for (const record of records) {
    if (record.usage?.cost === "calculated" && record.cost === 0) {
      record.usage.cost = "skipped";
    }
  }
}
