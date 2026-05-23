/**
 * @sriinnu/tokmeter-core — Main TokmeterCore class.
 *
 * Public API for scanning, aggregating, and querying token usage.
 * Consumable by CLI, TUI, web app, macOS bar, and external projects.
 */

import { homedir } from "node:os";
import {
  computeAllProjectsFromState,
  computeDailyBreakdownFromState,
  computeModelCostsFromState,
  computeProjectSummaryFromState,
  computeProviderBreakdownFromState,
  computeRawProjectNamesFromState,
  computeStatsFromRecords,
  computeStatsFromState,
} from "./aggregate-consumers.js";
import { DailyAccumulator } from "./aggregates-store.js";
import { type DailyAggregate, aggregateRecordsByDay } from "./aggregates.js";
import { filterByDate, filterByProject, filterByProvider } from "./aggregator.js";
import { type AliasMap, loadAliases } from "./alias-service.js";
import { isBeforeToday, localDateKey, startOfLocalDay, yesterdayDateKey } from "./date-utils.js";
import {
  loadHistorySnapshot,
  saveHistorySnapshot,
  shouldKeepExistingHistory,
  sumSnapshotTokens,
} from "./history-snapshot.js";
import { getParsers } from "./parsers/index.js";
import {
  getCachedKoshaMtime,
  saveRecordCacheToDisk,
  setCachedKoshaMtime,
} from "./parsers/utils.js";
import { PricingService } from "./pricing.js";
import { computeStatbarSignals } from "./signals.js";
import { saveSummaryCache } from "./summary-cache.js";
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ProviderId,
  ScanMeta,
  ScanOptions,
  ScanWarning,
  StatbarSignals,
  TokenRecord,
  TokmeterConfig,
  TokmeterStats,
  TokmeterSummary,
} from "./types.js";

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
const OPAQUE_MODELS: ReadonlySet<string> = new Set(["codex-auto-review"]);

function isOpaqueModel(model: string): boolean {
  return OPAQUE_MODELS.has(model);
}

/**
 * How many days of records to hold in {@link TokmeterCore.recentRecords}.
 * Sized to the longest signal lookback (pace baseline = 7 days × 2 = 14)
 * so {@link computeStatbarSignals} sees enough history without scaling RSS
 * with lifetime record count.
 */
const RECENT_RECORDS_WINDOW_DAYS = 14;

const EMPTY_SCAN_META: ScanMeta = {
  stableThrough: null,
  historySource: "none",
  todayState: "snapshot-only",
  lastScanAt: 0,
  warnings: [],
  unpricedModels: [],
  unpricedRecords: 0,
};

export class TokmeterCore {
  /**
   * Rolling 14-day window of records — the lookback needed by `signals.ts`
   * (burn rate, pace baseline, billing window). Replaces the lifetime
   * `this.records` array we used to hold; lifetime data lives in
   * {@link aggregates} + {@link todayAccumulator} now. Sized to the longest
   * signal lookback so the daemon's hot path keeps its precision without
   * paying the lifetime RSS cost.
   *
   * Phase 3 retirement: external getters (`getRecords`, summary `records`
   * field) now expose this 14-day window. Callers needing lifetime data
   * should migrate to the aggregate getters (`getStats`, `getDailyBreakdown`,
   * `getAllProjects`).
   */
  private recentRecords: TokenRecord[] = [];
  /**
   * Per-day historical aggregates, keyed by `YYYY-MM-DD`. Built from the full
   * scan and updated by `refreshToday()`. Today's day is tracked separately
   * in {@link todayAccumulator}; this map covers days strictly before today.
   * Single source of truth for lifetime reporting after the Phase 3 cutover.
   */
  private aggregates: Map<string, DailyAggregate> = new Map();
  /**
   * Live in-memory accumulator for today's running aggregate. Folds today's
   * records as they come in from the warm scan. Sealed and written to disk
   * at midnight rollover. Null only before the first `scan()` completes.
   */
  private todayAccumulator: DailyAccumulator | null = null;
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
      const frozen = await this.resolveFrozenHistory(
        stableThrough,
        referenceTimestamp,
        Boolean(options?.rescanHistory),
        historyWarnings
      );
      historySource = frozen.historySource;

      const todayRecords = await this.scanTodayRecords(
        options?.providers,
        referenceTimestamp,
        todayWarnings
      );

      records = [...frozen.records, ...todayRecords];
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

    if (this.skipPricing) {
      this.markPricingSkipped(records);
    }

    // Calculate costs for records that don't have them
    const unpricedTracker = { models: new Set<string>(), records: 0 };
    if (records.length > 0 && !this.skipPricing) {
      const todayRecords = records.filter(
        (record) => !isBeforeToday(record.timestamp, referenceTimestamp)
      );

      // Historical records are FROZEN and are NEVER touched here. Whatever cost
      // they carry is the value frozen when they were first priced — by the
      // snapshot file (reused verbatim) or by the one-time pricing during a
      // rebuild/gap scan. We deliberately do NOT run enrichCosts over history:
      // a record frozen at $0 (model not in kosha that day) must STAY $0 even
      // after a `kosha update`. Re-pricing $0 history at today's rates was the
      // silent immutability leak — "even a second-ago record is history." The
      // only way frozen cost ever changes is an explicit `rescanHistory`.
      //
      // Only today's records reprice when kosha is updated — today is still
      // "in flight", so updated rates flow through (zero, then re-enrich).
      if (koshaChanged && todayRecords.length > 0) {
        for (const r of todayRecords) {
          r.cost = 0;
        }
      }

      if (todayRecords.length > 0) {
        await this.enrichCosts(todayRecords, "today", todayWarnings, unpricedTracker);
      }

      // Persist the kosha mtime tied to the cost values we just wrote so
      // subsequent runs know whether another reprice is needed.
      if (currentKoshaMtime > 0) {
        setCachedKoshaMtime(currentKoshaMtime);
        saveRecordCacheToDisk();
      }
    }

    this.recentRecords = this.sliceRecent(records, referenceTimestamp);
    this.rebuildAggregateState(records, referenceTimestamp);
    this.scanMeta = {
      stableThrough: isTodayOnlyScan ? null : stableThrough,
      historySource: isTodayOnlyScan ? "none" : historySource,
      todayState: this.resolveTodayState(records, todayWarnings, isTodayOnlyScan),
      lastScanAt: Date.now(),
      warnings: [...historyWarnings, ...todayWarnings],
      unpricedModels: [...unpricedTracker.models].sort(),
      unpricedRecords: unpricedTracker.records,
    };

    // Feedback channel to kosha: drop a wishlist of models we couldn't price
    // along with their hit counts. Kosha reads this on the next `update` and
    // can bias provider priority toward what's actually being used. Without
    // this, kosha has no way to know which models matter to the user.
    this.writeKoshaWishlist(unpricedTracker, records);

    const summaryCacheWarnings = saveSummaryCache(this.homeDir, this.getSummary());
    if (summaryCacheWarnings.length > 0) {
      this.scanMeta = {
        ...this.scanMeta,
        warnings: [...this.scanMeta.warnings, ...summaryCacheWarnings],
      };
    }

    return records;
  }

  /**
   * Cheap warm-path refresh: re-scan ONLY today (stat-pruned to today's active
   * files) and splice it into the loaded records, leaving frozen history
   * untouched. This is what lets a long-lived daemon stay warm and update
   * every few seconds without ever re-reading the whole corpus — the fix for
   * the statusline/daemon RAM blow-up that was panicking the machine.
   *
   * Falls back to a single full {@link scan} when the core is cold (no history
   * loaded yet) so there's a frozen base to splice onto.
   */
  async refreshToday(now: number = Date.now()): Promise<TokenRecord[]> {
    // Cold start: no aggregate state loaded → fall back to a full scan so
    // the warm path has a frozen base to splice today's records onto.
    if (this.todayAccumulator === null) {
      return this.scan();
    }

    const todayWarnings: ScanWarning[] = [];

    // Detect a kosha edit so today (still in flight) reprices at current rates.
    // History is never touched here — it stays frozen, per the immutability rule.
    let koshaChanged = false;
    if (!this.skipPricing) {
      try {
        await this.pricing.init();
      } catch {
        // enrichCosts re-warns if pricing stays unavailable.
      }
      const currentKoshaMtime = this.pricing.getRegistryMtime();
      const cachedKoshaMtime = getCachedKoshaMtime();
      koshaChanged = currentKoshaMtime > 0 && currentKoshaMtime !== cachedKoshaMtime;
    }

    const today = await this.scanTodayRecords(undefined, now, todayWarnings);

    if (this.skipPricing) {
      this.markPricingSkipped(today);
    } else if (koshaChanged && today.length > 0) {
      // today is mutable — drop stale cached cost and reprice at current kosha.
      for (const r of today) r.cost = 0;
      await this.enrichCosts(today, "today", todayWarnings);
      const currentKoshaMtime = this.pricing.getRegistryMtime();
      if (currentKoshaMtime > 0) {
        setCachedKoshaMtime(currentKoshaMtime);
        saveRecordCacheToDisk();
      }
    }

    // Roll forward the 14-day window: drop today's stale slice from
    // recentRecords, append the fresh today scan. Aggregates already hold
    // historical days; only today's accumulator needs to be replaced.
    const recentHistory = this.recentRecords.filter((r) => isBeforeToday(r.timestamp, now));
    this.recentRecords = this.sliceRecent([...recentHistory, ...today], now);
    this.refreshTodayAccumulator(today, now);

    this.scanMeta = {
      ...this.scanMeta,
      todayState: this.resolveTodayState(this.recentRecords, todayWarnings, false),
      lastScanAt: Date.now(),
      warnings: [...this.scanMeta.warnings.filter((w) => w.scope !== "today"), ...todayWarnings],
    };

    // We deliberately do NOT call `saveSummaryCache` here. The persisted
    // summary cache is an OFFLINE FALLBACK read when the daemon is unreachable
    // — not a per-tick hot-path artifact. `getSummary()` includes the full
    // records array; stringifying ~272k records every 12s would spike the
    // daemon by hundreds of MB on each refresh. The cache is refreshed on
    // every full `scan()` (cold start, explicit rescan, pricing update) which
    // is already the right cadence — a fallback reader gets the snapshot as
    // of the last full scan; "today" lags slightly, which is the acceptable
    // price for not torching memory on every warm refresh.

    return this.recentRecords;
  }

  /**
   * Slice the recent records window: keep the last
   * {@link RECENT_RECORDS_WINDOW_DAYS} of records relative to the reference
   * timestamp. Sized to the longest signal lookback (pace's 14-day baseline)
   * so {@link computeStatbarSignals} keeps precision while RSS stays bounded.
   */
  private sliceRecent(records: TokenRecord[], referenceTimestamp: number): TokenRecord[] {
    const cutoff = referenceTimestamp - RECENT_RECORDS_WINDOW_DAYS * 86_400_000;
    const out: TokenRecord[] = [];
    for (const r of records) if (r.timestamp >= cutoff) out.push(r);
    return out;
  }

  /**
   * Rebuild the per-day aggregate map + today's accumulator from a fresh
   * record set. Called from `scan()` after `this.recentRecords` is set, so
   * the state stays in sync. Pure rebuild (no incremental delta) — cheap
   * relative to the scan that produced these records.
   */
  private rebuildAggregateState(records: TokenRecord[], referenceTimestamp: number): void {
    const todayKey = localDateKey(referenceTimestamp);
    const allDays = aggregateRecordsByDay(records);
    this.aggregates = new Map();
    let todayAgg: DailyAggregate | undefined;
    for (const day of allDays) {
      if (day.date === todayKey) {
        todayAgg = day;
      } else {
        this.aggregates.set(day.date, day);
      }
    }
    const acc = new DailyAccumulator(todayKey);
    if (todayAgg) acc.hydrate(todayAgg);
    this.todayAccumulator = acc;
  }

  /**
   * Lightweight today-only update for the warm-refresh path (`refreshToday`).
   * Replaces just the today accumulator without rebuilding historical
   * aggregates (those are already correct from the last `scan()`).
   */
  private refreshTodayAccumulator(todayRecords: TokenRecord[], referenceTimestamp: number): void {
    const todayKey = localDateKey(referenceTimestamp);
    const [todayAgg] = aggregateRecordsByDay(todayRecords);
    const acc = new DailyAccumulator(todayKey);
    if (todayAgg && todayAgg.date === todayKey) acc.hydrate(todayAgg);
    this.todayAccumulator = acc;
  }

  /**
   * Historical aggregates only (days before today). Phase 1 of the aggregate
   * cutover: this is read-only state that consumers can opt into; existing
   * consumers still read `getRecords()`. Returns a stable snapshot — callers
   * may iterate while the daemon refreshes (today is excluded; only frozen
   * days are here).
   */
  getDailyAggregates(): DailyAggregate[] {
    return [...this.aggregates.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );
  }

  /**
   * Today's live aggregate view (current accumulator snapshot). Null only
   * before the first scan completes. Returns a new object — caller can hold
   * it across refreshes without seeing the accumulator mutate underneath.
   */
  getTodayAggregate(): DailyAggregate | null {
    return this.todayAccumulator?.toAggregate() ?? null;
  }

  /**
   * Returns the rolling 14-day records window — sized to the longest signal
   * lookback. Callers needing lifetime data should migrate to the aggregate
   * getters ({@link getStats}, {@link getDailyBreakdown}, {@link getAllProjects}).
   *
   * Semantic break landed in Phase 3 of the aggregate cutover so the daemon's
   * RSS stops scaling with lifetime record count.
   */
  getRecords(): TokenRecord[] {
    return this.recentRecords;
  }

  /** Metadata describing the last scan's stable/live composition state. */
  getScanMeta(): ScanMeta {
    return {
      ...this.scanMeta,
      warnings: [...this.scanMeta.warnings],
    };
  }

  /** Get summaries for all projects. Respects user aliases (merge + hide). */
  /** Project rollup — alias-resolved displays + per-(model, provider)
   *  cross-cut totals + per-day breakdown. Phase 2.3 aggregate migration;
   *  parity-tested. */
  getAllProjects(): ProjectSummary[] {
    return computeAllProjectsFromState(this.aggregates, this.todayAccumulator, this.getAliases());
  }

  /** All raw canonical project names seen during scan (pre-alias). Used by
   *  the `alias suggest` command to detect case-insensitive duplicates.
   *  Aggregate-path migration (Phase 2.2); parity-tested. */
  getRawProjectNames(): string[] {
    return computeRawProjectNamesFromState(this.aggregates, this.todayAccumulator);
  }

  /** Single ProjectSummary lookup — exact match first, then substring.
   *  Phase 2.3 aggregate migration. */
  getProjectSummary(projectName: string): ProjectSummary | undefined {
    return computeProjectSummaryFromState(
      this.aggregates,
      this.todayAccumulator,
      this.getAliases(),
      projectName
    );
  }

  /**
   * Get model summaries, optionally filtered by project / date window.
   * Reads from aggregate state — project filter walks per-(project, model)
   * cross-cut buckets added in Phase 2.3. Parity-tested.
   */
  getModelCosts(options?: {
    project?: string;
    since?: string;
    until?: string;
    today?: boolean;
    providers?: ProviderId[];
  }): ModelSummary[] {
    return computeModelCostsFromState(this.aggregates, this.todayAccumulator, {
      today: options?.today,
      since: options?.since,
      until: options?.until,
      project: options?.project,
      providers: options?.providers,
    });
  }

  /** Get provider breakdown across all records. */
  /**
   * Provider breakdown — total cost / tokens / models / percentage-of-total
   * per provider. Reads from per-day perProvider buckets + perModel.providers
   * lists. Phase 2 of the cutover; parity-tested.
   */
  getProviderBreakdown() {
    return computeProviderBreakdownFromState(this.aggregates, this.todayAccumulator);
  }

  /**
   * Cross-tool comparison: project today's exact token shape against each of
   * the user's top N models from lifetime usage. Surfaces "if all of today's
   * tokens had run on model X instead, you'd have spent $Y" — the kind of
   * comparison nobody else ships because most trackers don't have a unified
   * pricing oracle. Universal-first: no hardcoded model list; the projection
   * uses kosha live so the lineup reflects what's actually billable today.
   *
   * Returns an array of {model, provider, projectedCost} sorted by projected
   * cost ascending (cheapest alternative first). Actual today's cost is
   * exposed separately so the UI can mark the "you used these" baseline.
   */
  async getCrossToolComparison(): Promise<{
    todayActualCost: number;
    todayTokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      reasoning: number;
    };
    projections: Array<{
      model: string;
      provider: ProviderId;
      projectedCost: number;
    }>;
  }> {
    const today = this.getTodayAggregate();
    const totals = {
      input: today?.inputTokens ?? 0,
      output: today?.outputTokens ?? 0,
      cacheRead: today?.cacheReadTokens ?? 0,
      cacheWrite: today?.cacheWriteTokens ?? 0,
      reasoning: today?.reasoningTokens ?? 0,
    };
    const actual = today?.cost ?? 0;
    // Top 6 lifetime models — the lineup the user has demonstrated by use.
    // Hardcoding a "popular models" list would violate the universal-first
    // principle; projecting against the user's actual lineup is honest and
    // useful (these are the alternatives they'd realistically pick).
    const topModels = this.getModelCosts().slice(0, 6);
    const projections = await Promise.all(
      topModels.map(async (m) => ({
        model: m.model,
        provider: m.provider,
        projectedCost: await this.pricing.calculateCost(
          m.model,
          totals.input,
          totals.output,
          totals.cacheRead,
          totals.cacheWrite,
          totals.reasoning
        ),
      }))
    );
    projections.sort((a, b) => a.projectedCost - b.projectedCost);
    return {
      todayActualCost: actual,
      todayTokens: totals,
      projections,
    };
  }

  /**
   * Get daily breakdown, optionally filtered by date range and project. Reads
   * from per-day aggregates + today's accumulator — Phase 2 of the cutover.
   * Same {@link DailyEntry} shape the legacy records-walking impl returned;
   * parity-tested in aggregate-migration-parity.test.ts.
   */
  getDailyBreakdown(options?: {
    since?: string;
    until?: string;
    project?: string;
    providers?: ProviderId[];
  }): DailyEntry[] {
    return computeDailyBreakdownFromState(this.aggregates, this.todayAccumulator, options);
  }

  /**
   * Overall stats. Two call shapes:
   *   - `getStats({ providers })` — aggregate path, optionally provider-filtered
   *   - `getStats(records[])` — legacy records-walking path, kept for callers
   *      that already have a filtered array in hand (parity-tested).
   */
  getStats(arg?: TokenRecord[] | { providers?: ProviderId[] }): TokmeterStats {
    const aliases = this.getAliases();
    if (Array.isArray(arg)) return computeStatsFromRecords(arg, aliases);
    return computeStatsFromState(this.aggregates, this.todayAccumulator, aliases, {
      providers: arg?.providers,
    });
  }

  /**
   * Live "right now" signals — burn rate, cache hit, pace, compaction tax,
   * live session. Each call recomputes against the current wall clock so the
   * bar can poll this and watch the numbers move.
   */
  getStatbarSignals(now: number = Date.now()): StatbarSignals {
    return computeStatbarSignals(this.recentRecords, now);
  }

  /** Get a serialisable summary payload with data plus scan metadata. */
  getSummary(): TokmeterSummary {
    return {
      records: this.recentRecords,
      projects: this.getAllProjects(),
      models: this.getModelCosts(),
      daily: this.getDailyBreakdown(),
      stats: this.getStats(),
      meta: this.getScanMeta(),
      signals: this.getStatbarSignals(),
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
    warnings: ScanWarning[],
    unpricedTracker?: { models: Set<string>; records: number }
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
          !this.pricing.hasUserOverride(r.model) &&
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
          message: `Pricing lookup failed for ${r.model} — leaving cost at $0 (${this.toErrorMessage(error)}).`,
        });
        if (unpricedTracker && !isOpaqueModel(r.model)) {
          unpricedTracker.models.add(r.model);
          unpricedTracker.records += 1;
        }
      }
    });
    await Promise.all(costPromises);
  }

  /**
   * Resolve the frozen pre-today history with an APPEND-ONLY strategy.
   *
   * The old behaviour discarded the snapshot and re-derived all of history
   * from disk on every calendar rollover — which re-priced the past at today's
   * kosha and lost tokens whenever a provider scan hiccuped. This is the fix:
   *
   *  1. Exact snapshot match → reuse verbatim. No scan, no reprice.
   *  2. Stale snapshot (frozen through an EARLIER day) → keep its records as an
   *     immutable base and freeze only the GAP days on top. Base cost is never
   *     recomputed, so a record-cache version bump can't rewrite frozen days.
   *  3. No usable snapshot / explicit rescan / schema bump → full rebuild,
   *     guarded by {@link HISTORY_FLOOR_RATIO} so a partial or failed scan can
   *     never clobber a materially larger frozen snapshot.
   */
  private async resolveFrozenHistory(
    stableThrough: string,
    referenceTimestamp: number,
    forceRescan: boolean,
    warnings: ScanWarning[]
  ): Promise<{ records: TokenRecord[]; historySource: ScanMeta["historySource"] }> {
    const snapshot = forceRescan ? null : loadHistorySnapshot(this.homeDir, stableThrough);
    if (snapshot) warnings.push(...snapshot.warnings);

    // 1) Exact match — reuse the frozen file as-is. No scan, no reprice.
    if (snapshot && snapshot.historySource === "snapshot" && snapshot.matchesExpected) {
      return { records: snapshot.records, historySource: "snapshot" };
    }

    // 2) Stale-but-usable snapshot frozen through an earlier day → append-only.
    const storedThrough = snapshot?.storedStableThrough ?? null;
    const canExtend =
      snapshot?.historySource === "snapshot" &&
      storedThrough !== null &&
      storedThrough < stableThrough;
    if (snapshot && canExtend && storedThrough !== null) {
      // Base = EVERYTHING the snapshot already froze — kept verbatim, never
      // dropped, re-scanned, or re-priced. We do NOT filter base to
      // `<= storedThrough`: if clock skew/DST left a record dated past the
      // stored key, filtering it out and trusting the gap re-scan to reproduce
      // it would silently lose frozen history when the source file is gone.
      // Keeping all of base makes the extension monotonic by construction
      // (extended = base + gap ≥ base), so it can never shrink the snapshot.
      const base = snapshot.records;
      // Anchor the gap boundary to the LATEST day actually present in the
      // snapshot (≥ storedThrough), so base and gap can never overlap (no
      // double-count) and no in-between day is skipped (no loss).
      let baseMaxDay = storedThrough;
      for (const r of base) {
        const key = localDateKey(r.timestamp);
        if (key > baseMaxDay) baseMaxDay = key;
      }
      // Gap = days that have since rolled from "today" into the frozen past
      // (> baseMaxDay and still before today). Only these get (re)derived.
      const warnBefore = warnings.length;
      const rebuilt = await this.scanHistoricalRecords(undefined, referenceTimestamp, warnings);
      const gap = rebuilt.filter(
        (r) =>
          localDateKey(r.timestamp) > baseMaxDay && isBeforeToday(r.timestamp, referenceTimestamp)
      );
      const extended = [...base, ...gap];
      // Only FREEZE the extension when the gap scan was clean. If a provider
      // failed mid-scan, the gap is incomplete — persist nothing so the next
      // healthy scan re-freezes it instead of locking in a degraded day. We
      // still return the best-effort extended set for this scan's display.
      // (extended ≥ base already, so a thin gap can never shrink the snapshot;
      // this guard just avoids freezing a day with a missing provider.)
      const gapDegraded = warnings.slice(warnBefore).some((w) => w.scope === "provider");
      if (!gapDegraded) {
        warnings.push(...saveHistorySnapshot(this.homeDir, stableThrough, extended));
      }
      return { records: extended, historySource: "extended" };
    }

    // 3) Full rebuild — first run, explicit rescan, schema bump, or a snapshot we
    //    can't safely extend. Guarded so a partial/failed scan can't clobber a
    //    healthy frozen snapshot.
    const warnBefore = warnings.length;
    const rebuilt = await this.scanHistoricalRecords(undefined, referenceTimestamp, warnings);
    const providerFailed = warnings.slice(warnBefore).some((w) => w.scope === "provider");

    // Only treat a snapshot as a protectable floor when it's a valid frozen-past
    // (frozen through today's key or earlier); a future-dated snapshot from clock
    // skew isn't trustworthy as a floor.
    const protectable =
      snapshot?.historySource === "snapshot" &&
      storedThrough !== null &&
      storedThrough <= stableThrough &&
      snapshot.records.length > 0;
    const existingTokens = protectable ? sumSnapshotTokens(snapshot.records) : 0;
    const rebuiltTokens = sumSnapshotTokens(rebuilt);

    if (
      protectable &&
      shouldKeepExistingHistory(existingTokens, rebuiltTokens, {
        forceRescan,
        providerFailed,
      })
    ) {
      const rebuiltLabel = rebuiltTokens.toLocaleString();
      const existingLabel = existingTokens.toLocaleString();
      warnings.push({
        scope: "history",
        message: `Rebuilt history (${rebuiltLabel} tokens) fell below the safety floor relative to the frozen snapshot (${existingLabel} tokens) — keeping the snapshot to avoid clobbering frozen history (${stableThrough}); re-run with rescanHistory to override.`,
      });
      return { records: snapshot?.records ?? [], historySource: "snapshot" };
    }

    warnings.push(...saveHistorySnapshot(this.homeDir, stableThrough, rebuilt));
    return { records: rebuilt, historySource: rebuilt.length > 0 ? "rebuilt" : "none" };
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
    // Today's records can only live in files modified today, so hand parsers a
    // mtime watermark of local midnight. Parsers that honor it stat-prune the
    // corpus down to today's couple of active files — this is what keeps a
    // warm-daemon refresh (and any today-only scan) from cold-reading months
    // of history into memory.
    const rawRecords = await this.scanRawRecords(
      providers,
      "today",
      warnings,
      startOfLocalDay(referenceTimestamp)
    );
    return rawRecords.filter((record) => !isBeforeToday(record.timestamp, referenceTimestamp));
  }

  private markPricingSkipped(records: TokenRecord[]): void {
    for (const record of records) {
      if (record.usage?.cost === "calculated" && record.cost === 0) {
        record.usage.cost = "skipped";
      }
    }
  }

  private async scanRawRecords(
    providers: ProviderId[] | undefined,
    warningScope: "history" | "today",
    warnings: ScanWarning[],
    modifiedSinceMs?: number
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
    const scanOpts = modifiedSinceMs !== undefined ? { modifiedSinceMs } : undefined;
    const results = await Promise.all(
      parsers.map(async (parser) => {
        try {
          return await parser.scan(this.homeDir, scanOpts);
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
      // Today-scope enrichment is gated to records actually dated today.
      // A today-active file (e.g. a long-running Claude session whose JSONL
      // is appended to today) can ALSO contain records from yesterday that
      // appeared earlier in the same file. Those historical records are
      // FROZEN — their cost must not be touched here, even if they currently
      // sit at $0 (model wasn't in kosha that day). Without this gate, the
      // first today-scope scan would silently price every yesterday-tail
      // record at today's rates and write the new cost back through the
      // record cache, breaking the snapshot's frozen-cost invariant on the
      // next history extension.
      //
      // History-scope (rebuild / gap fill) prices everything as before —
      // those records are being freshly committed to the snapshot and need
      // an initial cost.
      const referenceTimestamp = Date.now();
      const recordsToPrice =
        warningScope === "today"
          ? records.filter((r) => !isBeforeToday(r.timestamp, referenceTimestamp))
          : records;
      if (recordsToPrice.length > 0) {
        await this.enrichCosts(recordsToPrice, warningScope, warnings);
      }
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

  /**
   * Write the kosha wishlist — every model tokmeter saw real usage on but
   * couldn't price. Kosha reads this on `kosha update` to bias provider
   * priority toward what the user actually needs.
   *
   * Synchronous + best-effort. Writing this should never block or fail a
   * scan. File is atomic-renamed so kosha can read mid-write safely.
   */
  private writeKoshaWishlist(
    unpricedTracker: { models: Set<string>; records: number },
    records: TokenRecord[]
  ): void {
    try {
      const fs = require("node:fs") as typeof import("node:fs");
      const path = require("node:path") as typeof import("node:path");
      const crypto = require("node:crypto") as typeof import("node:crypto");
      const dir = path.join(this.homeDir, ".tokmeter");
      const filePath = path.join(dir, "wishlist.json");

      // Empty tracker but a stale wishlist exists — clean it up so consumers
      // (bar, CI, kosha) don't keep flagging models that are no longer
      // unpriced. Without this, the file freezes at its last non-empty state
      // forever, which is exactly what bit codex-auto-review after the
      // opaque-models filter landed.
      if (unpricedTracker.models.size === 0) {
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* missing is fine */
        }
        return;
      }
      fs.mkdirSync(dir, { recursive: true });

      // Count hits per unpriced model from today's records.
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const sinceMs = todayStart.getTime();
      const hits = new Map<string, { hits: number; lastSeenAt: number }>();
      for (const r of records) {
        if (r.timestamp < sinceMs) continue;
        if (!unpricedTracker.models.has(r.model)) continue;
        const cur = hits.get(r.model);
        if (cur) {
          cur.hits += 1;
          if (r.timestamp > cur.lastSeenAt) cur.lastSeenAt = r.timestamp;
        } else {
          hits.set(r.model, { hits: 1, lastSeenAt: r.timestamp });
        }
      }

      const payload = {
        schemaVersion: 1,
        writtenAt: Date.now(),
        models: [...hits.entries()]
          .map(([id, v]) => ({ id, hits: v.hits, lastSeenAt: v.lastSeenAt }))
          .sort((a, b) => b.hits - a.hits),
      };
      const tmp = `${filePath}.${crypto.randomBytes(4).toString("hex")}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, filePath);
    } catch {
      // Wishlist is observability only — never block a scan.
    }
  }
}
