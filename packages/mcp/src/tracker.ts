/**
 * @tokmeter/drishti — Live file tracker.
 *
 * Polls TokmeterCore at a configurable interval and emits "update"
 * events whenever the record set changes. Computes session-level
 * metrics such as burn rate and tokens per minute.
 */

import { EventEmitter } from "node:events";
import {
  TokmeterCore,
  type TokenRecord,
  type ModelSummary,
  type ProviderSummary,
  type DailyEntry,
} from "@tokmeter/core";

// ─── Types ──────────────────────────────────────────────────────────

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

// ─── LiveTracker ────────────────────────────────────────────────────

export class LiveTracker extends EventEmitter {
  private core: TokmeterCore;
  private timer: ReturnType<typeof setInterval> | null = null;
  private refreshMs: number;
  private sessionId: string | undefined;
  private startedAt: number;
  private lastRecordCount = -1;
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

  /** Perform a single refresh cycle — scan, compute, and (maybe) emit. */
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

    // Elapsed time for rate calculations
    const elapsedMs = Date.now() - this.startedAt;
    const elapsedHours = elapsedMs / 3_600_000;
    const elapsedMinutes = elapsedMs / 60_000;

    const sessionTokens = sessionRecords.reduce(
      (sum, r) =>
        sum +
        r.inputTokens +
        r.outputTokens +
        r.cacheReadTokens +
        r.cacheWriteTokens +
        r.reasoningTokens,
      0,
    );

    const burnRate = elapsedHours > 0 ? sessionCost / elapsedHours : 0;
    const tokensPerMin = elapsedMinutes > 0 ? sessionTokens / elapsedMinutes : 0;

    const snapshot: Snapshot = {
      records,
      stats,
      models,
      providers,
      daily,
      sessionRecords,
      sessionCost,
      todayCost,
      burnRate,
      tokensPerMin,
      lastUpdated: Date.now(),
    };

    this._snapshot = snapshot;

    // Emit "update" only when the record count changes
    if (records.length !== this.lastRecordCount) {
      this.lastRecordCount = records.length;
      this.emit("update", snapshot);
    }

    return snapshot;
  }

  /** Filter records that belong to the current session. */
  private computeSessionRecords(records: TokenRecord[]): TokenRecord[] {
    // If a sessionId is set, try to match against sourceFile paths
    if (this.sessionId) {
      const matched = records.filter(
        (r) => r.sourceFile?.includes(this.sessionId!) ?? false,
      );
      if (matched.length > 0) return matched;
    }
    // Fallback: all records since the tracker was started
    return records.filter((r) => r.timestamp >= this.startedAt);
  }
}
