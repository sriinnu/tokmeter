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
import { DailyAccumulator, sealRolledOverDay } from "./aggregates-store.js";
import { type DailyAggregate, aggregateRecordsByDay } from "./aggregates.js";
import { filterByDate, filterByProject, filterByProvider } from "./aggregator.js";
import { type AliasMap, loadAliases } from "./alias-service.js";
import { type CrossToolComparison, computeCrossToolComparison } from "./cross-tool.js";
import { isBeforeToday, localDateKey, yesterdayDateKey } from "./date-utils.js";
import { writeKoshaWishlist } from "./kosha-wishlist.js";
import {
  getCachedKoshaMtime,
  saveRecordCacheToDisk,
  setCachedKoshaMtime,
} from "./parsers/utils.js";
import { enrichCosts, markPricingSkipped } from "./pricing-enrichment.js";
import { PricingService } from "./pricing.js";
import { rebuildRecentWindow, refreshFromRelay } from "./relay-loader.js";
import {
  type ScanContext,
  resolveTodayState,
  scanHistoricalRecords,
  scanRawRecords,
  scanTodayRecords,
  scanTodayRecordsWithStragglers,
} from "./scan-pipeline.js";
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

/** Longest signal lookback. Bounds daemon RSS by record count, not lifetime. */
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
  // Rolling 14-day window — feeds signals.ts; replaces lifetime records[].
  private recentRecords: TokenRecord[] = [];
  // Per-day historical aggregates keyed by YYYY-MM-DD; days strictly before today.
  private aggregates: Map<string, DailyAggregate> = new Map();
  // Live accumulator for today; null before the first scan completes.
  private todayAccumulator: DailyAccumulator | null = null;
  private pricing: PricingService;
  private homeDir: string;
  private skipPricing: boolean;
  private scanMeta: ScanMeta = EMPTY_SCAN_META;
  private aliases: AliasMap | null = null;

  constructor(config?: TokmeterConfig) {
    this.homeDir = config?.homeDir || homedir();
    this.skipPricing = config?.skipPricing ?? false;
    this.pricing = new PricingService(config?.cacheDir);
  }

  private getAliases(): AliasMap {
    if (!this.aliases) this.aliases = loadAliases(this.homeDir);
    return this.aliases;
  }

  /** Force a reload from disk — call after CLI mutations write the file. */
  reloadAliases(): void {
    this.aliases = loadAliases(this.homeDir);
  }

  private ctx(): ScanContext {
    return { homeDir: this.homeDir, pricing: this.pricing, skipPricing: this.skipPricing };
  }

  /**
   * Scan session files and refresh instance state.
   *
   * Default: relay load + bounded recent-window + today scan → 14d window.
   * Explicit-range (`since`/`until`/...): ad-hoc bounded raw scan for the
   * requested window; instance state still refreshes.
   */
  async scan(options?: ScanOptions): Promise<TokenRecord[]> {
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

    if (!this.skipPricing) {
      try {
        await this.pricing.init();
        const { maybeBackgroundRefresh } = await import("./pricing.js");
        maybeBackgroundRefresh();
      } catch {
        /* enrichCosts will re-warn if pricing stays unavailable */
      }
    }
    const currentKoshaMtime = this.pricing.getRegistryMtime();
    const koshaChanged =
      !this.skipPricing && currentKoshaMtime > 0 && currentKoshaMtime !== getCachedKoshaMtime();

    let historySource: ScanMeta["historySource"] = "snapshot";
    if (!isTodayOnlyScan) {
      const relay = await refreshFromRelay(
        this.ctx(),
        referenceTimestamp,
        historyWarnings,
        Boolean(options?.rescanHistory)
      );
      this.aggregates = relay.aggregates;
      historySource = relay.historySource;
    }

    const todayRecords = await scanTodayRecords(
      this.ctx(),
      options?.providers,
      referenceTimestamp,
      todayWarnings
    );

    // Historical days are frozen on disk; only today reprices here.
    const unpricedTracker = { models: new Set<string>(), records: 0 };
    if (todayRecords.length > 0 && !this.skipPricing) {
      if (koshaChanged) for (const r of todayRecords) r.cost = 0;
      await enrichCosts(todayRecords, this.pricing, "today", todayWarnings, unpricedTracker);
      if (currentKoshaMtime > 0) {
        setCachedKoshaMtime(currentKoshaMtime);
        saveRecordCacheToDisk();
      }
    }

    // recentRecords accumulates FORWARD — it is never re-derived from a raw
    // history scan. The invariant: a scan reads today's live files + the sealed
    // relay, nothing else. Past days for the bar's totals/chart come from the
    // relay aggregates; pace's intraday baseline comes from their costByHour.
    // The only thing recentRecords still feeds is today's burn/cache signals and
    // the rollover seal's straggler dedup — both satisfied by carrying the prior
    // window's before-today records + today. On cold start this.recentRecords is
    // empty, so it's today-only (and no seal runs — refreshTodayAccumulator only
    // seals when a prior accumulator exists, i.e. the daemon crossed midnight).
    const carriedRecent = this.recentRecords.filter((r) =>
      isBeforeToday(r.timestamp, referenceTimestamp)
    );
    this.recentRecords = this.sliceRecent([...carriedRecent, ...todayRecords], referenceTimestamp);
    this.refreshTodayAccumulator(todayRecords, referenceTimestamp);

    const hasExplicitRange = Boolean(
      options?.since || options?.until || options?.week || options?.month || options?.year
    );
    let returned: TokenRecord[];
    if (hasExplicitRange && !isTodayOnlyScan) {
      const mtimeFloor = options?.since ? new Date(options.since).getTime() : 0;
      const adHoc = await scanRawRecords(
        this.ctx(),
        options?.providers,
        "history",
        historyWarnings,
        mtimeFloor
      );
      returned = adHoc;
      if (options?.providers?.length) returned = filterByProvider(returned, options.providers);
      if (options?.project) returned = filterByProject(returned, options.project);
      returned = filterByDate(returned, options ?? {});
      if (this.skipPricing) markPricingSkipped(returned);
    } else {
      returned = this.recentRecords;
      if (options?.providers?.length) returned = filterByProvider(returned, options.providers);
      if (options?.project) returned = filterByProject(returned, options.project);
      if (isTodayOnlyScan) returned = filterByDate(returned, options ?? {});
      if (this.skipPricing) markPricingSkipped(returned);
    }

    this.scanMeta = {
      stableThrough: isTodayOnlyScan ? null : stableThrough,
      historySource: isTodayOnlyScan ? "none" : historySource,
      todayState: resolveTodayState(returned, todayWarnings, isTodayOnlyScan),
      lastScanAt: Date.now(),
      warnings: [...historyWarnings, ...todayWarnings],
      unpricedModels: [...unpricedTracker.models].sort(),
      unpricedRecords: unpricedTracker.records,
    };

    writeKoshaWishlist(this.homeDir, unpricedTracker, returned);
    const summaryCacheWarnings = saveSummaryCache(this.homeDir, this.getSummary());
    if (summaryCacheWarnings.length > 0) {
      this.scanMeta = {
        ...this.scanMeta,
        warnings: [...this.scanMeta.warnings, ...summaryCacheWarnings],
      };
    }

    return returned;
  }

  /**
   * Warm-path refresh: today-only scan + splice into the rolling window.
   * The daemon's hot path. Falls back to a full {@link scan} on cold start.
   */
  async refreshToday(now: number = Date.now()): Promise<TokenRecord[]> {
    if (this.todayAccumulator === null) return this.scan();

    const todayWarnings: ScanWarning[] = [];
    let koshaChanged = false;
    if (!this.skipPricing) {
      try {
        await this.pricing.init();
      } catch {
        /* enrichCosts re-warns if pricing stays unavailable */
      }
      const mtime = this.pricing.getRegistryMtime();
      koshaChanged = mtime > 0 && mtime !== getCachedKoshaMtime();
    }

    const { today, stragglers } = await scanTodayRecordsWithStragglers(
      this.ctx(),
      undefined,
      now,
      todayWarnings
    );

    if (this.skipPricing) {
      markPricingSkipped(today);
    } else if (koshaChanged && today.length > 0) {
      for (const r of today) r.cost = 0;
      await enrichCosts(today, this.pricing, "today", todayWarnings);
      const mtime = this.pricing.getRegistryMtime();
      if (mtime > 0) {
        setCachedKoshaMtime(mtime);
        saveRecordCacheToDisk();
      }
    }

    const recentHistory = this.recentRecords.filter((r) => isBeforeToday(r.timestamp, now));
    this.recentRecords = this.sliceRecent([...recentHistory, ...today], now);
    this.refreshTodayAccumulator(today, now, stragglers);

    this.scanMeta = {
      ...this.scanMeta,
      todayState: resolveTodayState(this.recentRecords, todayWarnings, false),
      lastScanAt: Date.now(),
      // Drop the previous tick's today AND provider warnings before merging —
      // this tick's todayWarnings carries both kinds afresh. Without the
      // provider filter, a persistently unreadable file added one identical
      // warning per 12s tick, growing scanMeta.warnings (and every
      // /api/summary payload) without bound.
      warnings: [
        ...this.scanMeta.warnings.filter((w) => w.scope !== "today" && w.scope !== "provider"),
        ...todayWarnings,
      ],
    };

    // No saveSummaryCache here: that's an offline fallback, not per-tick —
    // serializing recentRecords every 12s would spike RSS by hundreds of MB.
    return this.recentRecords;
  }

  private sliceRecent(records: TokenRecord[], referenceTimestamp: number): TokenRecord[] {
    const cutoff = referenceTimestamp - RECENT_RECORDS_WINDOW_DAYS * 86_400_000;
    const out: TokenRecord[] = [];
    for (const r of records) if (r.timestamp >= cutoff) out.push(r);
    return out;
  }

  private refreshTodayAccumulator(
    todayRecords: TokenRecord[],
    referenceTimestamp: number,
    stragglers: TokenRecord[] = []
  ): void {
    const todayKey = localDateKey(referenceTimestamp);

    // Seal-on-rollover. If the daemon ran across midnight, the outgoing
    // accumulator holds a now-complete past day — freeze it into the relay so
    // the day survives even if its raw JSONL is later deleted, instead of
    // waiting for a cold-start gap-fill that re-reads the JSONL.
    const prev = this.todayAccumulator;
    if (prev) {
      // Re-derive the outgoing day from a DEDUPED aggregation of its records
      // rather than folding stragglers into the accumulator. `prev` is built
      // via hydrate(), which clears the fingerprint set — so folding a
      // straggler that was already counted before midnight would double-count
      // it into the immutable sealed day. Instead, aggregate the union of the
      // last-seen recent records + freshly-scanned stragglers for that day;
      // aggregateRecordsByDay dedups by fingerprint, so an already-counted
      // record collapses (no double-count) while a genuinely late record is
      // still captured (no loss). Falls back to the accumulator's own totals
      // if no records for the day are in memory.
      const outgoing = [...this.recentRecords, ...stragglers].filter(
        (r) => localDateKey(r.timestamp) === prev.date
      );
      const derived = aggregateRecordsByDay(outgoing).find((d) => d.date === prev.date);
      const toSeal = new DailyAccumulator(prev.date);
      toSeal.hydrate(derived ?? prev.toAggregate());
      const sealed = sealRolledOverDay(this.homeDir, toSeal, todayKey);
      if (sealed) this.aggregates.set(sealed.date, sealed);
    }

    // Never let a day live in BOTH the sealed-aggregates map and the live
    // accumulator: if the wall clock steps backward across midnight (NTP step,
    // VM snapshot restore, suspend/resume, manual set) todayKey can equal a
    // day already sealed into `aggregates`, and the read layer would count it
    // twice. Evict the map entry — the live accumulator becomes the single
    // owner of today, and it is re-hydrated from a fresh scan just below.
    this.aggregates.delete(todayKey);

    const [todayAgg] = aggregateRecordsByDay(todayRecords);
    const acc = new DailyAccumulator(todayKey);
    if (todayAgg && todayAgg.date === todayKey) acc.hydrate(todayAgg);
    this.todayAccumulator = acc;
  }

  // ─── Read API — delegators to aggregate-consumers + signals ──────────────

  getDailyAggregates(): DailyAggregate[] {
    return [...this.aggregates.values()].sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : 0
    );
  }

  /**
   * Deep rescan, bounded. Re-derives the last `windowDays` sealed days from raw
   * and overwrites just those relay files — backfilling pace's costByHour and
   * correcting any recently mis-sealed day — WITHOUT the full-history parse that
   * can exhaust memory. Older days (which pace never reads) are left as-is.
   * Streaming + windowed, so peak memory stays bounded. Today is untouched.
   */
  async rebuildRecentDays(
    windowDays: number,
    now: number = Date.now(),
    force = false
  ): Promise<void> {
    const warnings: ScanWarning[] = [];
    const relay = await rebuildRecentWindow(this.ctx(), now, warnings, windowDays, force);
    this.aggregates = relay.aggregates;
    this.scanMeta = {
      ...this.scanMeta,
      lastScanAt: Date.now(),
      // The rebuild emits history AND provider warnings — replace both kinds
      // rather than stacking a fresh copy per rescan.
      warnings: [
        ...this.scanMeta.warnings.filter((w) => w.scope !== "history" && w.scope !== "provider"),
        ...warnings,
      ],
    };
  }

  getTodayAggregate(): DailyAggregate | null {
    return this.todayAccumulator?.toAggregate() ?? null;
  }

  /** Rolling 14-day window; lifetime callers should use the aggregate getters. */
  getRecords(): TokenRecord[] {
    return this.recentRecords;
  }

  /**
   * Unbounded raw scan of the ENTIRE corpus (all providers, all time), each
   * record carrying its `sourceFile`. This is the RAM-heavy full-corpus path
   * the relay exists to avoid on hot reads — use it ONLY for operations that
   * genuinely need per-record file identity across all history (cleanup), never
   * for the poll loop. `scan()`/`getRecords()` return only the rolling 14-day
   * window, so a caller that used them for cleanup silently ignored everything
   * older than 14 days (and under-detected partial-file collateral). No relay
   * mutation — read-only.
   */
  async scanLifetimeRaw(providers?: ProviderId[]): Promise<TokenRecord[]> {
    const ref = Date.now();
    const warnings: ScanWarning[] = [];
    const history = await scanHistoricalRecords(this.ctx(), providers, ref, warnings);
    const today = await scanTodayRecords(this.ctx(), providers, ref, warnings);
    if (this.skipPricing) markPricingSkipped([...history, ...today]);
    return [...history, ...today];
  }

  getScanMeta(): ScanMeta {
    return { ...this.scanMeta, warnings: [...this.scanMeta.warnings] };
  }

  getAllProjects(): ProjectSummary[] {
    return computeAllProjectsFromState(this.aggregates, this.todayAccumulator, this.getAliases());
  }

  getRawProjectNames(): string[] {
    return computeRawProjectNamesFromState(this.aggregates, this.todayAccumulator);
  }

  getProjectSummary(projectName: string): ProjectSummary | undefined {
    return computeProjectSummaryFromState(
      this.aggregates,
      this.todayAccumulator,
      this.getAliases(),
      projectName
    );
  }

  getModelCosts(options?: {
    project?: string;
    since?: string;
    until?: string;
    today?: boolean;
    providers?: ProviderId[];
  }): ModelSummary[] {
    return computeModelCostsFromState(this.aggregates, this.todayAccumulator, options ?? {});
  }

  getProviderBreakdown() {
    return computeProviderBreakdownFromState(this.aggregates, this.todayAccumulator);
  }

  async getCrossToolComparison(): Promise<CrossToolComparison> {
    const top = this.getModelCosts().slice(0, 6);
    return computeCrossToolComparison(this.pricing, this.getTodayAggregate(), top);
  }

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

  getStatbarSignals(now: number = Date.now()): StatbarSignals {
    // Pace reads its baseline from the sealed relay curves (getDailyAggregates),
    // not from raw history — so recentRecords only needs to carry TODAY.
    //
    // The raw-record-backed signals (burnRate 60m, billingWindow ~10h,
    // cross-midnight contextPressure) read recentRecords. A long-running daemon
    // accumulates yesterday's tail forward (see scan()/refreshToday), so these
    // are exact in normal operation. The only degraded case is a FRESH cold
    // start in the first hours after midnight (recentRecords is today-only): a
    // just-past-midnight billing block or burn window may under-report until
    // the window fills. This is a deliberate trade — seeding a raw recent scan
    // on cold start would reintroduce the multi-day parse that melts the daemon.
    return computeStatbarSignals(this.recentRecords, now, this.getDailyAggregates());
  }

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

  toJSON(): TokmeterSummary {
    return this.getSummary();
  }
}
