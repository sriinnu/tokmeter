/**
 * @sriinnu/tokmeter-core — Main TokmeterCore class.
 *
 * Public API for scanning, aggregating, and querying token usage.
 * Consumable by CLI, TUI, web app, macOS bar, and external projects.
 */

import { homedir } from "node:os";
import { type AliasMap, loadAliases, resolveProjectName } from "./alias-service.js";
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
import {
  getCachedKoshaMtime,
  saveRecordCacheToDisk,
  setCachedKoshaMtime,
} from "./parsers/utils.js";
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
  /**
   * Cached alias map. Loaded lazily on first call that needs it and
   * refreshable via `reloadAliases()`. Each aggregation call resolves
   * raw canonical project names through this map.
   */
  private aliases: AliasMap | null = null;

  constructor(config?: TokmeterConfig) {
    this.homeDir = config?.homeDir || homedir();
    this.skipPricing = config?.skipPricing ?? false;
    this.pricing = new PricingService(config?.cacheDir);
  }

  /** Lazy load the user's alias map. */
  private getAliases(): AliasMap {
    if (!this.aliases) this.aliases = loadAliases(this.homeDir);
    return this.aliases;
  }

  /** Force a reload from disk — call after CLI mutations write the file. */
  reloadAliases(): void {
    this.aliases = loadAliases(this.homeDir);
  }

  /**
   * Scan all session files and build token usage records.
   * This is the main entry point — call this first.
   *
   * @param options - Filter and provider options for the scan.
   * @returns Array of parsed token usage records.
   */
  async scan(options?: ScanOptions): Promise<TokenRecord[]> {
    // Re-read aliases from disk at the start of every scan so the daemon
    // picks up edits to ~/.tokmeter/aliases.json without needing a restart.
    // Aliases are a display-layer only (records are unchanged) so this
    // doesn't invalidate any history/cache — it just changes how the next
    // aggregateByProject() call groups the rows.
    this.reloadAliases();

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

    // Detect kosha registry updates. If the user edited ~/.kosha/registry.json
    // since the last scan, every cached `cost` field is suspect — force a
    // reprice so new/updated rates flow through without a full re-parse.
    if (!this.skipPricing) {
      try {
        await this.pricing.init();
        // Fire-and-forget refresh if the registry is stale (>24h). The current
        // scan uses whatever data we have on disk; the refresh runs in the
        // background so the *next* scan benefits. Failures are silent.
        const { maybeBackgroundRefresh } = await import("./pricing.js");
        maybeBackgroundRefresh();
      } catch {
        // enrichCosts will re-warn if pricing stays unavailable
      }
    }
    const currentKoshaMtime = this.pricing.getRegistryMtime();
    const cachedKoshaMtime = getCachedKoshaMtime();
    const koshaChanged =
      !this.skipPricing && currentKoshaMtime > 0 && currentKoshaMtime !== cachedKoshaMtime;

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

      // Historical records are FROZEN — whatever cost was calculated when
      // they were first priced is what they stay at forever. If yesterday's
      // Qwen was $0 because the model wasn't in kosha, it stays $0. You don't
      // retroactively rebill the past when today's rates change, same as you
      // don't go back to the gas station when petrol gets cheaper.
      //
      // Only today's records get repriced when kosha is updated — today is
      // still "in flight" so updated rates should flow through.
      if (koshaChanged && todayRecords.length > 0) {
        for (const r of todayRecords) {
          r.cost = 0;
        }
      }

      if (historicalRecords.length > 0) {
        await this.enrichCosts(historicalRecords, "history", historyWarnings);
      }

      if (todayRecords.length > 0) {
        await this.enrichCosts(todayRecords, "today", todayWarnings);
      }

      // Persist the kosha mtime tied to the cost values we just wrote so
      // subsequent runs know whether another reprice is needed.
      if (currentKoshaMtime > 0) {
        setCachedKoshaMtime(currentKoshaMtime);
        saveRecordCacheToDisk();
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

  /** Get summaries for all projects. Respects user aliases (merge + hide). */
  getAllProjects(): ProjectSummary[] {
    return aggregateByProject(this.records, this.getAliases());
  }

  /** All raw canonical project names seen during scan (pre-alias). Used by
   *  the `alias suggest` command to detect case-insensitive duplicates. */
  getRawProjectNames(): string[] {
    return Array.from(new Set(this.records.map((r) => r.project)));
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
  getModelCosts(options?: { project?: string; since?: string; until?: string; today?: boolean }): ModelSummary[] {
    let records = this.records;
    if (options?.project) {
      records = filterByProject(records, options.project);
    }
    if (options?.today || options?.since || options?.until) {
      records = filterByDate(records, options);
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

    // Count distinct projects by their RESOLVED display name, but skip raws
    // that are entirely hidden — so stats.projects always matches the number
    // of rows in the per-project table. A display is hidden only when EVERY
    // raw contributing to it is hidden; any non-hidden contributor keeps it
    // visible (same rule as aggregateByProject).
    const aliases = this.getAliases();
    const displayVisible = new Map<string, boolean>();
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
      const display = resolveProjectName(r.project, aliases);
      // A display stays "visible" as long as at least one of its raws is
      // not hidden. Track visibility incrementally across the single pass.
      const isHidden = aliases[r.project]?.hidden === true;
      if (!isHidden) displayVisible.set(display, true);
      else if (!displayVisible.has(display)) displayVisible.set(display, false);
      modelSet.add(r.model);
      providerSet.add(r.provider);
      daySet.add(localDateKey(r.timestamp));
    }
    for (const [display, visible] of displayVisible) {
      if (visible) projectSet.add(display);
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
