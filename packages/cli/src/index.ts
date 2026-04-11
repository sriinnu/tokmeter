import { PricingService, TokmeterCore } from "@sriinnu/tokmeter";
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ScanOptions,
  TokmeterStats,
  TokmeterSummary,
} from "@sriinnu/tokmeter";
import { type CleanupArgs, runCleanup } from "./cleanup.js";
import { type DigestArgs, runDigest } from "./digest.js";
import { type RestoreArgs, runRestore } from "./restore.js";

/** Query options shared by the convenience helpers exported from `@sriinnu/tokmeter-cli`. */
export interface TokmeterQueryOptions extends ScanOptions {
  /** Skip pricing lookups for faster scans when only token counts matter. */
  light?: boolean;
}

/** Pricing payload returned by the convenience model-pricing helper. */
export type TokmeterPricing = Awaited<ReturnType<PricingService["getPricing"]>>;

/** Result shape for model pricing lookups. */
export interface TokmeterPricingLookup {
  model: string;
  pricing: TokmeterPricing;
}

async function scanCore(options: TokmeterQueryOptions = {}): Promise<TokmeterCore> {
  const core = new TokmeterCore({ skipPricing: options.light });
  await core.scan(options);
  return core;
}

/**
 * Load the full Tokmeter summary in the same shape used by the web dashboard and JSON CLI output.
 */
export async function loadTokmeterSummary(
  options: TokmeterQueryOptions = {}
): Promise<TokmeterSummary> {
  const core = await scanCore(options);
  return core.getSummary();
}

/**
 * Load per-project usage summaries for automation, CI checks, or cross-project dashboards.
 */
export async function loadTokmeterProjects(
  options: TokmeterQueryOptions = {}
): Promise<ProjectSummary[]> {
  const core = await scanCore(options);
  return core.getAllProjects();
}

/**
 * Load per-model usage and cost data, optionally filtered by project/provider/date.
 */
export async function loadTokmeterModels(
  options: TokmeterQueryOptions = {}
): Promise<ModelSummary[]> {
  const core = await scanCore(options);
  return core.getModelCosts({ project: options.project });
}

/**
 * Load the daily usage breakdown for building charts or time-series automations.
 */
export async function loadTokmeterDailyBreakdown(
  options: TokmeterQueryOptions = {}
): Promise<DailyEntry[]> {
  const core = await scanCore(options);
  return core.getDailyBreakdown({
    since: options.since,
    until: options.until,
    project: options.project,
  });
}

/**
 * Load the aggregate usage statistics that back the CLI overview and dashboard hero cards.
 */
export async function loadTokmeterStats(
  options: TokmeterQueryOptions = {}
): Promise<TokmeterStats> {
  const core = await scanCore(options);
  return core.getStats();
}

/**
 * Resolve pricing for a single model using Tokmeter's pricing stack.
 *
 * Returns `null` when the model is unknown to the pricing sources.
 */
export async function lookupTokmeterPricing(
  modelId: string
): Promise<TokmeterPricingLookup | null> {
  const pricing = new PricingService();
  await pricing.init();

  const resolvedPricing = await pricing.getPricing(modelId);
  if (!resolvedPricing) {
    return null;
  }

  return {
    model: modelId,
    pricing: resolvedPricing,
  };
}

export { runCleanup, runDigest, runRestore };
export type { CleanupArgs, DigestArgs, RestoreArgs };
