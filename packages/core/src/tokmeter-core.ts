/**
 * @tokmeter/core — Main TokmeterCore class.
 *
 * Public API for scanning, aggregating, and querying token usage.
 * Consumable by CLI, TUI, web app, macOS bar, and external projects.
 */

import { homedir } from "node:os";
import {
  aggregateByDate,
  aggregateByModel,
  aggregateByProject,
  aggregateByProvider,
  filterByDate,
  filterByProject,
} from "./aggregator.js";
import { getParsers } from "./parsers/index.js";
import { PricingService } from "./pricing.js";
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ScanOptions,
  TokenRecord,
  TokmeterConfig,
} from "./types.js";

export class TokmeterCore {
  private records: TokenRecord[] = [];
  private pricing: PricingService;
  private homeDir: string;
  private skipPricing: boolean;

  constructor(config?: TokmeterConfig) {
    this.homeDir = config?.homeDir || homedir();
    this.skipPricing = config?.skipPricing ?? false;
    this.pricing = new PricingService(config?.cacheDir);
  }

  /**
   * Scan all session files and build token usage records.
   * This is the main entry point — call this first.
   *
   * @param options - Filter and provider options for the scan.
   * @returns Array of parsed token usage records.
   */
  async scan(options?: ScanOptions): Promise<TokenRecord[]> {
    // Initialize pricing unless explicitly skipped
    if (!this.skipPricing) {
      await this.pricing.init();
    }

    // Get relevant parsers
    const parsers = getParsers(options?.providers);

    // Run all parsers in parallel
    const results = await Promise.all(parsers.map((p) => p.scan(this.homeDir)));
    let records = results.flat();

    // Apply filters
    if (options?.project) {
      records = filterByProject(records, options.project);
    }
    if (
      options?.since ||
      options?.until ||
      options?.today ||
      options?.week ||
      options?.month ||
      options?.year
    ) {
      records = filterByDate(records, options);
    }

    // Calculate costs for records that don't have them
    if (records.length > 0 && !this.skipPricing) {
      await this.enrichCosts(records);
    }

    this.records = records;
    return records;
  }

  /** Get all loaded records. */
  getRecords(): TokenRecord[] {
    return this.records;
  }

  /** Get summaries for all projects. */
  getAllProjects(): ProjectSummary[] {
    return aggregateByProject(this.records);
  }

  /** Get summary for a specific project (by exact name or substring match). */
  getProjectSummary(projectName: string): ProjectSummary | undefined {
    const all = this.getAllProjects();
    return all.find(
      (p) =>
        p.project === projectName || p.project.toLowerCase().includes(projectName.toLowerCase())
    );
  }

  /** Get model summaries, optionally filtered by project. */
  getModelCosts(options?: { project?: string }): ModelSummary[] {
    let records = this.records;
    if (options?.project) {
      records = filterByProject(records, options.project);
    }
    return aggregateByModel(records);
  }

  /** Get provider breakdown across all records. */
  getProviderBreakdown() {
    return aggregateByProvider(this.records);
  }

  /** Get daily breakdown, optionally filtered by date range and project. */
  getDailyBreakdown(options?: { since?: string; until?: string; project?: string }): DailyEntry[] {
    let records = this.records;
    if (options?.project) {
      records = filterByProject(records, options.project);
    }
    if (options?.since || options?.until) {
      records = filterByDate(records, options);
    }
    return aggregateByDate(records);
  }

  /**
   * Get overall stats — computed in a single pass over all records.
   *
   * Returns totals, unique counts, and longest activity streak.
   */
  getStats() {
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let totalCost = 0;
    let firstUsed = Number.POSITIVE_INFINITY;
    let lastUsed = Number.NEGATIVE_INFINITY;

    const projectSet = new Set<string>();
    const modelSet = new Set<string>();
    const providerSet = new Set<unknown>();
    const daySet = new Set<string>();

    for (const r of this.records) {
      inputTokens += r.inputTokens;
      outputTokens += r.outputTokens;
      cacheReadTokens += r.cacheReadTokens;
      cacheWriteTokens += r.cacheWriteTokens;
      reasoningTokens += r.reasoningTokens;
      totalCost += r.cost;
      if (r.timestamp < firstUsed) firstUsed = r.timestamp;
      if (r.timestamp > lastUsed) lastUsed = r.timestamp;
      projectSet.add(r.project);
      modelSet.add(r.model);
      providerSet.add(r.provider);
      daySet.add(new Date(r.timestamp).toISOString().slice(0, 10));
    }

    const totalTokens =
      inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens;
    const days = [...daySet].sort();

    // Calculate longest consecutive-day streak
    let longestStreak = 0;
    let currentStreak = 1;
    for (let i = 1; i < days.length; i++) {
      const diff = (new Date(days[i]).getTime() - new Date(days[i - 1]).getTime()) / 86400000;
      if (diff === 1) {
        currentStreak++;
        longestStreak = Math.max(longestStreak, currentStreak);
      } else {
        currentStreak = 1;
      }
    }
    longestStreak = Math.max(longestStreak, currentStreak, days.length > 0 ? 1 : 0);

    return {
      totalTokens,
      totalCost,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      totalRecords: this.records.length,
      projects: projectSet.size,
      models: modelSet.size,
      providers: providerSet.size,
      activeDays: daySet.size,
      longestStreak,
      firstUsed: this.records.length ? firstUsed : 0,
      lastUsed: this.records.length ? lastUsed : 0,
    };
  }

  /**
   * Export everything as a JSON-serialisable object.
   *
   * The output shape matches what the web app and macOS bar expect.
   */
  toJSON(): {
    records: TokenRecord[];
    projects: ProjectSummary[];
    models: ModelSummary[];
    daily: DailyEntry[];
    stats: ReturnType<TokmeterCore["getStats"]>;
  } {
    return {
      records: this.records,
      projects: this.getAllProjects(),
      models: this.getModelCosts(),
      daily: this.getDailyBreakdown(),
      stats: this.getStats(),
    };
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
  private async enrichCosts(records: TokenRecord[]): Promise<void> {
    const costPromises = records.map(async (r) => {
      if (r.cost > 0) return; // already has cost
      r.cost = await this.pricing.calculateCost(
        r.model,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.reasoningTokens
      );
    });
    await Promise.all(costPromises);
  }
}
