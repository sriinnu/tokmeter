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

async function scanSummary(options: TokmeterQueryOptions = {}): Promise<TokmeterSummary> {
  const core = new TokmeterCore({ skipPricing: options.light });
  core.getSummary(options); // Validate calendar bounds before any scan I/O.
  await core.scan({ today: options.today, rescanHistory: options.rescanHistory });
  return core.getSummary(options);
}

/**
 * Load the full Tokmeter summary in the same shape used by the web dashboard and JSON CLI output.
 */
export async function loadTokmeterSummary(
  options: TokmeterQueryOptions = {}
): Promise<TokmeterSummary> {
  return scanSummary(options);
}

/**
 * Load per-project usage summaries for automation, CI checks, or cross-project dashboards.
 */
export async function loadTokmeterProjects(
  options: TokmeterQueryOptions = {}
): Promise<ProjectSummary[]> {
  return (await scanSummary(options)).projects;
}

/**
 * Load per-model usage and cost data, optionally filtered by project/provider/date.
 */
export async function loadTokmeterModels(
  options: TokmeterQueryOptions = {}
): Promise<ModelSummary[]> {
  return (await scanSummary(options)).models;
}

/**
 * Load the daily usage breakdown for building charts or time-series automations.
 */
export async function loadTokmeterDailyBreakdown(
  options: TokmeterQueryOptions = {}
): Promise<DailyEntry[]> {
  return (await scanSummary(options)).daily;
}

/**
 * Load the aggregate usage statistics that back the CLI overview and dashboard hero cards.
 */
export async function loadTokmeterStats(
  options: TokmeterQueryOptions = {}
): Promise<TokmeterStats> {
  return (await scanSummary(options)).stats;
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
