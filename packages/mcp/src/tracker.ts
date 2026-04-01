/**
 * @tokmeter/drishti — Live file tracker.
 *
 * Polls TokmeterCore at a configurable interval and emits "update"
 * events whenever the record set changes. Computes session-level
 * metrics such as burn rate and tokens per minute.
 *
 * The tracker maintains a {@link Snapshot} that includes precomputed
 * token aggregations for both session and all-today records, avoiding
 * expensive O(n) reduces in hot render paths like the TUI.
 */

import { EventEmitter } from "node:events";
import {
  type DailyEntry,
  type ModelSummary,
  type ProviderSummary,
  type TokenRecord,
  TokmeterCore,
} from "@tokmeter/core";

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
  /** Dollars per hour (based on session elapsed time). */
  burnRate: number;
  /** Total tokens per minute (based on session elapsed time). */
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
 * Compute a lightweight hash of the record set for change detection.
 * Considers both count and cost totals so we emit updates when
 * costs are recalculated even if the record count stays the same.
 */
function snapshotHash(records: TokenRecord[]): string {
  let costSum = 0;
  let tokenSum = 0;
  for (const r of records) {
    costSum += r.cost;
    tokenSum += r.inputTokens + r.outputTokens;
  }
  return `${records.length}:${costSum.toFixed(6)}:${tokenSum}`;
}

// ─── LiveTracker ────────────────────────────────────────────────────

/**
 * Polls TokmeterCore and emits "update" events when the data changes.
 *
 * Emits:
 * - `"update"` — when records change (count, cost, or token totals)
 * - `"error"` — when a refresh cycle fails
 */
export class LiveTracker extends EventEmitter {
  private core: TokmeterCore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshMs: number;
  private sessionId: string | undefined;
  private startedAt: number;
  /** Hash of the last emitted snapshot — used for change detection. */
  private lastHash = "";
  private _snapshot: Snapshot | null = null;

  constructor(options?: LiveTrackerOptions) {
    super();
    this.refreshMs = options?.refreshMs ?? 2000;
    this.sessionId = options?.sessionId;
    this.startedAt = Date.now();
    this.core = new TokmeterCore({ skipPricing: false });
  }

  /** Get the most recent snapshot (or null before first refresh). */
  get snapshot(): Snapshot | null {
    return this._snapshot;
  }

  /** Start polling. Performs an immediate refresh on start. */
  async start(): Promise<void> {
    await this.refresh();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => this.emit("error", err));
    }, this.refreshMs);
  }

  /** Stop polling. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Update the session ID filter. */
  setSessionId(id: string): void {
    this.sessionId = id;
  }

  /**
   * Perform a single refresh cycle — scan, compute, and (maybe) emit.
   *
   * Emits "update" when the data hash changes (record count, cost totals,
   * or token totals differ from the last emission). This ensures consumers
   * see updates even when record count stays the same but costs change.
   */
  async refresh(): Promise<Snapshot> {
    const records = await this.core.scan({ today: true });
    const stats = this.core.getStats() as Stats;
    const models = this.core.getModelCosts();
    const providers = this.core.getProviderBreakdown();
    const daily = this.core.getDailyBreakdown();

    // Session records: records since the tracker started, or matching sessionId
    const sessionRecords = this.computeSessionRecords(records);
    const sessionCost = sessionRecords.reduce((sum, r) => sum + r.cost, 0);
    const todayCost = records.reduce((sum, r) => sum + r.cost, 0);

    // Precomputed token breakdown — avoids O(n) per render frame
    const sessionTokens = computeTokenBreakdown(sessionRecords);

    // Elapsed time for rate calculations
    const elapsedMs = Date.now() - this.startedAt;
    const elapsedHours = elapsedMs / 3_600_000;
    const elapsedMinutes = elapsedMs / 60_000;

    const burnRate = elapsedHours > 0 ? sessionCost / elapsedHours : 0;
    const tokensPerMin = elapsedMinutes > 0 ? sessionTokens.totalTokens / elapsedMinutes : 0;

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
      lastUpdated: Date.now(),
    };

    this._snapshot = snapshot;

    // Emit "update" when data actually changes (count, cost, or tokens)
    const hash = snapshotHash(records);
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
    // Fallback: all records since the tracker was started
    return records.filter((r) => r.timestamp >= this.startedAt);
  }
}
