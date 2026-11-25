/**
 * @sriinnu/tokmeter-mcp — Live file tracker.
 *
 * Refreshes snapshots from the warm singleton daemon HTTP API when available,
 * falling back to an in-process TokmeterCore scan only when offline. Computes
 * session-level metrics and rolling 60-minute burn rates without launch spikes.
 */

import { EventEmitter } from "node:events";
import {
  type DailyEntry,
  fetchDaemonJson,
  localDateKey,
  type ModelSummary,
  type ProviderSummary,
  type StatbarSignals,
  type TokenRecord,
  TokmeterCore,
  type TokmeterSummary,
} from "@sriinnu/tokmeter";

const ROLLING_WINDOW_MS = 60 * 60_000;

// ─── Types ──────────────────────────────────────────────────────────

/** Precomputed token breakdown — avoids per-frame reduces in consumers. */
export interface TokenBreakdown {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

/** Aggregated stats computed from the current record set. */
export interface Stats {
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalRecords: number;
  projects: number;
  models: number;
  providers: number;
  activeDays: number;
  longestStreak: number;
  firstUsed: number;
  lastUsed: number;
}

/** A point-in-time snapshot of all tracked data. */
export interface Snapshot {
  records: TokenRecord[];
  stats: Stats;
  models: ModelSummary[];
  providers: ProviderSummary[];
  daily: DailyEntry[];
  sessionRecords: TokenRecord[];
  sessionCost: number;
  todayCost: number;
  /** Precomputed token breakdown for session records. */
  sessionTokens: TokenBreakdown;
  /** Dollars per hour over the trailing 60-minute rolling window. */
  burnRate: number;
  /** Total tokens per minute over the trailing 60-minute rolling window. */
  tokensPerMin: number;
  /** Epoch ms of the last successful refresh. */
  lastUpdated: number;
}

/** Options for constructing a LiveTracker. */
export interface LiveTrackerOptions {
  /** Polling interval in ms (default: 2000). */
  refreshMs?: number;
  /** Optional session ID to filter session records. */
  sessionId?: string;
  /** Custom home directory for daemon auth & local fallback scans. */
  homeDir?: string;
  /** Optional env override (e.g. TOKMETER_DAEMON_PORT). */
  env?: NodeJS.ProcessEnv;
  /** Set to false to skip daemon HTTP lookups and scan via local core only. */
  preferDaemon?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Compute a token breakdown from an array of records in a single pass.
 * Used to precompute aggregations so consumers don't need per-frame reduces.
 */
function computeTokenBreakdown(records: TokenRecord[]): TokenBreakdown {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reasoningTokens = 0;

  for (const r of records) {
    inputTokens += r.inputTokens;
    outputTokens += r.outputTokens;
    cacheReadTokens += r.cacheReadTokens;
    cacheWriteTokens += r.cacheWriteTokens;
    reasoningTokens += r.reasoningTokens;
  }

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
  };
}

/**
 * Compute trailing rolling-window burn rate ($/h) and tokens/min. Uses a fixed
 * window duration (default 60 minutes) rather than `Date.now() - startedAt` so
 * freshly started trackers never show artificial launch spikes.
 */
export function computeRollingRates(
  records: TokenRecord[],
  now = Date.now(),
  windowMs = ROLLING_WINDOW_MS
): { burnRate: number; tokensPerMin: number; activeRecords: number } {
  if (windowMs <= 0) return { burnRate: 0, tokensPerMin: 0, activeRecords: 0 };
  const since = now - windowMs;
  let cost = 0;
  let tokens = 0;
  let activeRecords = 0;
  for (const r of records) {
    if (r.timestamp < since || r.timestamp > now) continue;
    cost += r.cost;
    tokens +=
      r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens;
    activeRecords++;
  }
  const hours = windowMs / 3_600_000;
  const minutes = windowMs / 60_000;
  return {
    burnRate: cost / hours,
    tokensPerMin: tokens / minutes,
    activeRecords,
  };
}

/**
 * Compute a lightweight hash of the record set for change detection.
 * Considers both count and cost totals so we emit updates when
 * costs are recalculated even if the record count stays the same.
 */
function snapshotHash(records: TokenRecord[], stats: Stats): string {
  let costSum = 0;
  let tokenSum = 0;
  for (const r of records) {
    costSum += r.cost;
    tokenSum += r.inputTokens + r.outputTokens;
  }
  return `${records.length}:${costSum.toFixed(6)}:${tokenSum}:${stats.totalRecords}:${stats.totalCost.toFixed(6)}`;
}

// ─── LiveTracker ────────────────────────────────────────────────────

/**
 * Polls the warm daemon (or falls back to TokmeterCore) and emits "update"
 * events when the snapshot changes.
 *
 * Emits:
 * - `"update"` — when records/stats change
 * - `"error"` — when a refresh cycle fails
 */
export class LiveTracker extends EventEmitter {
  private core: TokmeterCore | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshMs: number;
  private sessionId: string | undefined;
  private homeDir: string | undefined;
  private env: NodeJS.ProcessEnv | undefined;
  private preferDaemon: boolean;
  private startedAt: number;
  /** Hash of the last emitted snapshot — used for change detection. */
  private lastHash = "";
  private _snapshot: Snapshot | null = null;

  constructor(options?: LiveTrackerOptions) {
    super();
    this.refreshMs = options?.refreshMs ?? 2000;
    this.sessionId = options?.sessionId;
    this.homeDir = options?.homeDir;
    this.env = options?.env;
    this.preferDaemon = options?.preferDaemon ?? true;
    this.startedAt = Date.now();
  }

  /** Get the most recent snapshot (or null before first refresh). */
  get snapshot(): Snapshot | null {
    return this._snapshot;
  }

  /** Start polling. Performs an immediate refresh on start. */
  async start(): Promise<void> {
    await this.refresh();
    this.scheduleNext();
  }

  /** Schedule the next refresh after the configured interval. */
  private scheduleNext(): void {
    if (this.timer) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.refresh();
      } catch (err) {
        this.emit("error", err);
      }
      this.scheduleNext();
    }, this.refreshMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** Update the session ID filter. */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  private getLocalCore(): TokmeterCore {
    if (!this.core) {
      this.core = new TokmeterCore({ homeDir: this.homeDir, skipPricing: false });
    }
    return this.core;
  }

  private async tryFetchDaemon(): Promise<{
    records: TokenRecord[];
    stats: Stats;
    models: ModelSummary[];
    providers: ProviderSummary[];
    daily: DailyEntry[];
    signals?: StatbarSignals;
  } | null> {
    if (!this.preferDaemon) return null;
    const opts = {
      homeDir: this.homeDir,
      env: this.env,
      probeTimeoutMs: 750,
      timeoutMs: 10_000,
      warmingTimeoutMs: 60_000,
    };
    const [summaryRes, providersRes, signalsRes] = await Promise.all([
      fetchDaemonJson<TokmeterSummary>("/api/summary", opts),
      fetchDaemonJson<ProviderSummary[]>("/api/providers", opts),
      fetchDaemonJson<StatbarSignals>("/api/statbar-signals", opts),
    ]);
    if (!summaryRes.ok) return null;
    return {
      records: summaryRes.data.records ?? [],
      stats: summaryRes.data.stats as Stats,
      models: summaryRes.data.models,
      providers: providersRes.ok ? providersRes.data : [],
      daily: summaryRes.data.daily,
      signals: signalsRes.ok ? signalsRes.data : summaryRes.data.signals,
    };
  }

  /**
   * Perform a single refresh cycle — prefer warm daemon HTTP API, fall back
   * to local core when offline, compute session & rolling-window metrics,
   * and emit "update" when data changes.
   */
  async refresh(now: number = Date.now()): Promise<Snapshot> {
    let records: TokenRecord[];
    let stats: Stats;
    let models: ModelSummary[];
    let providers: ProviderSummary[];
    let daily: DailyEntry[];
    let daemonSignals: StatbarSignals | undefined;

    const fromDaemon = await this.tryFetchDaemon();
    if (fromDaemon) {
      records = fromDaemon.records;
      stats = fromDaemon.stats;
      models = fromDaemon.models;
      providers = fromDaemon.providers;
      daily = fromDaemon.daily;
      daemonSignals = fromDaemon.signals;
    } else {
      const core = this.getLocalCore();
      records = await core.scan();
      stats = core.getStats() as Stats;
      models = core.getModelCosts();
      providers = core.getProviderBreakdown();
      daily = core.getDailyBreakdown();
      daemonSignals = core.getStatbarSignals(now);
    }

    const sessionRecords = this.computeSessionRecords(records);
    const sessionCost = sessionRecords.reduce((sum, r) => sum + r.cost, 0);
    const todayKey = localDateKey(now);
    const todayCost = daily.find((entry) => entry.date === todayKey)?.cost ?? 0;
    const sessionTokens = computeTokenBreakdown(sessionRecords);

    const rolling = computeRollingRates(records, now);
    const burnRate = daemonSignals ? daemonSignals.burnRate.costPerHour : rolling.burnRate;
    const tokensPerMin = daemonSignals
      ? daemonSignals.burnRate.tokensPerHour / 60
      : rolling.tokensPerMin;

    const snapshot: Snapshot = {
      records,
      stats,
      models,
      providers,
      daily,
      sessionRecords,
      sessionCost,
      todayCost,
      sessionTokens,
      burnRate,
      tokensPerMin,
      lastUpdated: now,
    };

    this._snapshot = snapshot;

    const hash = snapshotHash(records, stats);
    if (hash !== this.lastHash) {
      this.lastHash = hash;
      this.emit("update", snapshot);
    }

    return snapshot;
  }

  /**
   * Filter records that belong to the current session.
   *
   * Attempts to match by sessionId against sourceFile paths first.
   * Falls back to timestamp-based filtering (records since tracker started).
   */
  private computeSessionRecords(records: TokenRecord[]): TokenRecord[] {
    if (this.sessionId) {
      const matched = records.filter((r) => r.sourceFile?.includes(this.sessionId!) ?? false);
      if (matched.length > 0) return matched;
    }
    return records.filter((r) => r.timestamp >= this.startedAt);
  }
}
