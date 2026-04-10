/**
 * @sriinnu/tokmeter-core — Main TokmeterCore class.
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
  filterByProvider,
} from "./aggregator.js";
import { isBeforeToday, localDateKey, yesterdayDateKey } from "./date-utils.js";
import { loadHistorySnapshot, saveHistorySnapshot } from "./history-snapshot.js";
import { getParsers } from "./parsers/index.js";
import { saveRecordCacheToDisk } from "./parsers/utils.js";
import { PricingService } from "./pricing.js";
import { projectNameIncludes, projectNamesMatch } from "./project-name.js";
import { saveSummaryCache } from "./summary-cache.js";
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ProviderId,
  ScanMeta,
  ScanOptions,
  ScanWarning,
  TokenRecord,
  TokmeterConfig,
  TokmeterStats,
  TokmeterSummary,
} from "./types.js";

const EMPTY_SCAN_META: ScanMeta = {
  stableThrough: null,
  historySource: "none",
  todayState: "snapshot-only",
  lastScanAt: 0,
  warnings: [],
};

export class TokmeterCore {
  private records: TokenRecord[] = [];
  private pricing: PricingService;
  private homeDir: string;
  private skipPricing: boolean;
  private scanMeta: ScanMeta = EMPTY_SCAN_META;

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
    const referenceTimestamp = Date.now();
    const historyWarnings: ScanWarning[] = [];
    const todayWarnings: ScanWarning[] = [];
    const stableThrough = yesterdayDateKey(referenceTimestamp);
    const isTodayOnlyScan =
      options?.today === true &&
      !options?.since &&
      !options?.until &&
      !options?.week &&
      !options?.month &&
      !options?.year;

    let records: TokenRecord[];
    let historySource: ScanMeta["historySource"] = "none";

    if (isTodayOnlyScan) {
      records = await this.scanTodayRecords(options?.providers, referenceTimestamp, todayWarnings);
    } else {
      let stableRecords: TokenRecord[] = [];

      if (!options?.rescanHistory) {
        const snapshot = loadHistorySnapshot(this.homeDir, stableThrough);
        stableRecords = snapshot.records;
        historySource = snapshot.historySource;
        historyWarnings.push(...snapshot.warnings);
      }

      if (options?.rescanHistory || historySource === "none") {
        const rebuiltHistory = await this.scanHistoricalRecords(
          undefined,
          referenceTimestamp,
          historyWarnings
        );

        stableRecords = rebuiltHistory;
        historySource = rebuiltHistory.length > 0 ? "rebuilt" : historySource;
        historyWarnings.push(...saveHistorySnapshot(this.homeDir, stableThrough, rebuiltHistory));
      }

      const todayRecords = await this.scanTodayRecords(
        options?.providers,
        referenceTimestamp,
        todayWarnings
      );

      records = [...stableRecords, ...todayRecords];
    }

    // Apply filters
    if (options?.providers && options.providers.length > 0) {
      records = filterByProvider(records, options.providers);
    }
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
      const historicalRecords = records.filter((record) =>
        isBeforeToday(record.timestamp, referenceTimestamp)
      );
      const todayRecords = records.filter(
        (record) => !isBeforeToday(record.timestamp, referenceTimestamp)
      );

      if (historicalRecords.length > 0) {
        await this.enrichCosts(historicalRecords, "history", historyWarnings);
      }

      if (todayRecords.length > 0) {
        await this.enrichCosts(todayRecords, "today", todayWarnings);
      }
    }

    this.records = records;
    this.scanMeta = {
      stableThrough: isTodayOnlyScan ? null : stableThrough,
      historySource: isTodayOnlyScan ? "none" : historySource,
      todayState: this.resolveTodayState(records, todayWarnings, isTodayOnlyScan),
      lastScanAt: Date.now(),
      warnings: [...historyWarnings, ...todayWarnings],
    };

    const summaryCacheWarnings = saveSummaryCache(this.homeDir, this.getSummary());
    if (summaryCacheWarnings.length > 0) {
      this.scanMeta = {
        ...this.scanMeta,
        warnings: [...this.scanMeta.warnings, ...summaryCacheWarnings],
      };
    }

    return records;
  }

  /** Get all loaded records. */
  getRecords(): TokenRecord[] {
    return this.records;
  }

  /** Metadata describing the last scan's stable/live composition state. */
  getScanMeta(): ScanMeta {
    return {
      ...this.scanMeta,
      warnings: [...this.scanMeta.warnings],
    };
  }

  /** Get summaries for all projects. */
  getAllProjects(): ProjectSummary[] {
    return aggregateByProject(this.records);
  }

  /** Get summary for a specific project (by exact name or substring match). */
  getProjectSummary(projectName: string): ProjectSummary | undefined {
    const all = this.getAllProjects();

    return (
      all.find((project) => projectNamesMatch(project.project, projectName)) ||
      all.find((project) => projectNameIncludes(project.project, projectName))
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
  getStats(): TokmeterStats {
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
      daySet.add(localDateKey(r.timestamp));
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

  /** Get a serialisable summary payload with data plus scan metadata. */
  getSummary(): TokmeterSummary {
    return {
      records: this.records,
      projects: this.getAllProjects(),
      models: this.getModelCosts(),
      daily: this.getDailyBreakdown(),
      stats: this.getStats(),
      meta: this.getScanMeta(),
    };
  }

  /**
   * Export everything as a JSON-serialisable object.
   *
   * The output shape matches what the web app and macOS bar expect.
   */
  toJSON(): TokmeterSummary {
    return this.getSummary();
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
  private async enrichCosts(
    records: TokenRecord[],
    warningScope: "history" | "today",
    warnings: ScanWarning[]
  ): Promise<void> {
    const costPromises = records.map(async (r) => {
      if (r.cost > 0) return; // already has cost
      try {
        r.cost = await this.pricing.calculateCost(
          r.model,
          r.inputTokens,
          r.outputTokens,
          r.cacheReadTokens,
          r.cacheWriteTokens,
          r.reasoningTokens
        );
      } catch (error) {
        warnings.push({
          scope: warningScope,
          message: `Pricing lookup failed for ${r.model} — leaving cost at $0 (${this.toErrorMessage(error)}).`,
        });
      }
    });
    await Promise.all(costPromises);
  }

  private async scanHistoricalRecords(
    providers: ProviderId[] | undefined,
    referenceTimestamp: number,
    warnings: ScanWarning[]
  ): Promise<TokenRecord[]> {
    const rawRecords = await this.scanRawRecords(providers, "history", warnings);
    return rawRecords.filter((record) => isBeforeToday(record.timestamp, referenceTimestamp));
  }

  private async scanTodayRecords(
    providers: ProviderId[] | undefined,
    referenceTimestamp: number,
    warnings: ScanWarning[]
  ): Promise<TokenRecord[]> {
    const rawRecords = await this.scanRawRecords(providers, "today", warnings);
    return rawRecords.filter((record) => !isBeforeToday(record.timestamp, referenceTimestamp));
  }

  private async scanRawRecords(
    providers: ProviderId[] | undefined,
    warningScope: "history" | "today",
    warnings: ScanWarning[]
  ): Promise<TokenRecord[]> {
    if (!this.skipPricing) {
      try {
        await this.pricing.init();
      } catch (error) {
        warnings.push({
          scope: warningScope,
          message: `Pricing initialization failed — continuing without pricing (${this.toErrorMessage(error)}).`,
        });
      }
    }

    const parsers = getParsers(providers);
    const results = await Promise.all(
      parsers.map(async (parser) => {
        try {
          return await parser.scan(this.homeDir);
        } catch (error) {
          warnings.push({
            scope: "provider",
            provider: parser.providerId,
            message: `${parser.providerId} scan failed — skipped (${this.toErrorMessage(error)}).`,
          });
          return [] as TokenRecord[];
        }
      })
    );

    const records = results.flat();

    if (records.length > 0 && !this.skipPricing) {
      await this.enrichCosts(records, warningScope, warnings);
    }

    saveRecordCacheToDisk();
    return records;
  }

  private resolveTodayState(
    records: TokenRecord[],
    todayWarnings: ScanWarning[],
    isTodayOnlyScan: boolean
  ): ScanMeta["todayState"] {
    if (todayWarnings.length === 0) {
      return "live";
    }

    if (records.length > 0 || isTodayOnlyScan) {
      return "degraded";
    }

    return "snapshot-only";
  }

  private toErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
