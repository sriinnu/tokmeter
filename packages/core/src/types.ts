/**
 * @sriinnu/tokmeter-core — Shared type definitions.
 */

/** Provider identifiers for all supported AI coding agents. */
export type ProviderId =
  | "claude-code"
  | "opencode"
  | "codex"
  | "codex-desktop"
  | "gemini"
  | "cursor"
  | "amp"
  | "droid"
  | "openclaw"
  | "pi"
  | "kimi"
  | "qwen"
  | "roo-code"
  | "kilo"
  | "kilo-cli"
  | "mux"
  | "vscode-copilot"
  | "antigravity"
  | "zed"
  | "synthetic";

/** Where a record's usage facts came from. */
export type UsageTelemetrySource =
  | "provider_api_usage"
  | "tool_jsonl"
  | "tool_json"
  | "tool_sqlite"
  | "tool_csv"
  | "otel"
  | "statusline"
  | "synthetic"
  | "unknown";

/**
 * How a single usage bucket should be trusted.
 *
 * - direct: the upstream telemetry exposed this bucket directly
 * - normalized: Tokmeter transformed upstream fields into its canonical shape
 * - calculated: deterministic math after parsing, usually pricing
 * - estimated: heuristic/tokenizer approximation
 * - not_exposed: this tool/provider does not expose the bucket
 * - skipped: Tokmeter intentionally skipped calculating this bucket
 */
export type UsageMetricProvenance =
  | "direct"
  | "normalized"
  | "calculated"
  | "estimated"
  | "not_exposed"
  | "skipped";

/** Provenance for each canonical usage bucket on a TokenRecord. */
export interface UsageProvenance {
  source: UsageTelemetrySource;
  inputTokens: UsageMetricProvenance;
  outputTokens: UsageMetricProvenance;
  cacheReadTokens: UsageMetricProvenance;
  cacheWriteTokens: UsageMetricProvenance;
  reasoningTokens: UsageMetricProvenance;
  cost: UsageMetricProvenance;
  /** Short human-readable hints for source quirks, normalization, or gaps. */
  notes?: string[];
}

/** Optional compaction facts when the upstream tool exposes them. */
export interface CompactionTelemetry {
  source: UsageTelemetrySource;
  trigger?: "auto" | "manual";
  success?: boolean;
  durationMs?: number;
  preTokens?: number;
  postTokens?: number;
  /** 0..1, calculated as 1 - postTokens / preTokens when both are known. */
  compressionRatio?: number;
  error?: string;
}

/** A single token usage record parsed from a session file. */
export interface TokenRecord {
  /** Unix timestamp (ms) of the usage event. */
  timestamp: number;
  /** Project path or name (extracted from session file location). */
  project: string;
  /** Provider that generated this usage. */
  provider: ProviderId;
  /** Model ID (e.g. "claude-sonnet-4-20250514"). */
  model: string;
  /** Input tokens consumed. */
  inputTokens: number;
  /** Output tokens generated. */
  outputTokens: number;
  /** Cache read tokens. */
  cacheReadTokens: number;
  /** Cache write tokens. */
  cacheWriteTokens: number;
  /** Reasoning/thinking tokens. */
  reasoningTokens: number;
  /** Calculated cost in USD (via kosha-discovery pricing). */
  cost: number;
  /**
   * Whether pricing-enrichment is allowed to compute a dollar cost for this
   * record at all. Defaults to true. Set false when a record's token counts
   * are real but not trustworthy enough to price — e.g. a lump total with no
   * input/output split, where kosha DOES have real pricing for the model (so
   * the normal "no pricing available" not_exposed path never fires) but
   * pricing it anyway would mean guessing which per-tier rate applies. Scoped
   * per-record rather than per-model (see OPAQUE_MODELS in
   * pricing-enrichment.ts) because the same model can appear in both a
   * trustworthy, granular record (real CLI token_count events) and an
   * untrustworthy lump one (SQLite fallback) — blocking the model globally
   * would silently zero out the trustworthy record too.
   */
  costEligible?: boolean;
  /** Per-bucket source/trust metadata. */
  usage?: UsageProvenance;
  /** Compaction metadata for records tagged kind:"compaction", when exposed. */
  compaction?: CompactionTelemetry;
  /** Original session file path (for debugging). */
  sourceFile?: string;
  /** Actual working directory the session ran in (not the session log path). */
  cwd?: string;
  /**
   * Whether this record represents a normal user-driven turn or an overhead
   * call like a `/compact` summarization. Surfaced in the bar/dashboard so
   * the user can see what slice of spend is going to context maintenance
   * versus actual work. Defaults to "normal" when absent.
   */
  kind?: "normal" | "compaction";
  /**
   * Names of tool_use blocks in this assistant turn. Only populated by the
   * claude-code parser today — Claude Code is the only agent in the registry
   * that exposes the tool names in its JSONL. Used by the daemon to compute
   * "% of today's cost by tool" (Bash, Read, Edit, Task, …). When a turn has
   * multiple tool calls, the cost is split evenly across them in aggregation.
   * Empty array or undefined means "this turn was just text" (no tools).
   */
  toolCalls?: string[];
  /**
   * Whether this record came from a subagent JSONL (path contains
   * `/subagents/`). Claude Code's Task tool spawns subagents that write to a
   * separate file; previously the parser's depth-3 cap missed them entirely
   * (cost vanished from totals). Tag here so the aggregator can roll up
   * "subagent share of today" without losing the underlying cost in the
   * project total. Compaction kind takes priority over this flag — a
   * subagent compaction record is `kind:"compaction"` AND `isSubagent:true`.
   */
  isSubagent?: boolean;
}

/** Summary of token usage for a single model within a context. */
export interface ModelSummary {
  model: string;
  provider: ProviderId;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  cost: number;
  percentageOfTotal: number;
}

/** Summary of token usage for a single provider within a context. */
export interface ProviderSummary {
  provider: ProviderId;
  totalTokens: number;
  cost: number;
  models: string[];
  percentageOfTotal: number;
}

/** A single day's aggregated usage. */
export interface DailyEntry {
  date: string; // YYYY-MM-DD
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  cost: number;
  records: number;
}

/** Full summary for a project. */
export interface ProjectSummary {
  project: string;
  totalTokens: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  models: ModelSummary[];
  providers: ProviderSummary[];
  dailyBreakdown: DailyEntry[];
  activeDays: number;
  firstUsed: number;
  lastUsed: number;
}

/** Options for scan/filter operations. */
export interface ScanOptions {
  /** Only scan these providers. */
  providers?: ProviderId[];
  /** Only include records from this date onward (inclusive, YYYY-MM-DD or ISO). */
  since?: string;
  /** Only include records up to this date (inclusive). */
  until?: string;
  /** Shortcut: today only. */
  today?: boolean;
  /** Shortcut: last 7 days. */
  week?: boolean;
  /** Shortcut: current calendar month. */
  month?: boolean;
  /** Filter by year. */
  year?: number;
  /** Filter by project name/path substring. */
  project?: string;
  /** Force a rebuild of the frozen pre-today history snapshot. */
  rescanHistory?: boolean;
}

/** Non-fatal warning emitted during scan/cache composition. */
export interface ScanWarning {
  /** Area where the warning originated. */
  scope: "history" | "today" | "provider" | "cache";
  /** Optional provider when the warning is provider-specific. */
  provider?: ProviderId;
  /** Human-readable warning message. */
  message: string;
}

/** Scan metadata describing the stable-history/live-today composition state. */
export interface ScanMeta {
  /** Local date key (YYYY-MM-DD) through which history is frozen. */
  stableThrough: string | null;
  /**
   * Where frozen history came from:
   * - "snapshot"  — reused as-is from the frozen file (no re-derivation).
   * - "extended"  — base frozen records reused, only newly-frozen gap days
   *                 appended (append-only rollover; base cost untouched).
   * - "rebuilt"   — fully re-derived from disk (first run, explicit rescan,
   *                 or snapshot-schema bump). The only path that reprices.
   * - "none"      — unavailable / today-only scan.
   */
  historySource: "snapshot" | "extended" | "rebuilt" | "none";
  /** Current state of today's overlay data. */
  todayState: "live" | "degraded" | "snapshot-only";
  /** Epoch ms of the last completed scan. */
  lastScanAt: number;
  /** Non-fatal warnings gathered during scan/caching. */
  warnings: ScanWarning[];
  /** Models that have non-zero token usage but no pricing in any tier
   *  (kosha runtime, manifest fallback, or user override). Surfaces silent
   *  $0 leaks — the bug class that hit claude-opus-4-7 in 2026-04-29. */
  unpricedModels: string[];
  /** Number of records whose model couldn't be priced. Roughly proportional
   *  to dollar impact of the silent leak. */
  unpricedRecords: number;
}

/** Overall usage stats returned by TokmeterCore. */
export interface TokmeterStats {
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

/**
 * Live "how am I doing right now" signals for the statbar/dashboard hero.
 * These are derived from the same records that drive everything else, but
 * computed against a reference timestamp so the bar can show motion instead
 * of just totals.
 *
 *   - burnRate: dollars per hour over a recent window (default 60 min)
 *   - cacheHitToday: legacy read-share plus canonical total-input cache rate
 *   - pace: today's cost divided by typical cost-at-this-hour over the last
 *     N active days. >1 = above your usual rhythm, <1 = under.
 *   - compactionToday: how much of today's spend went to /compact overhead
 *   - liveSession: the most recently-active record within the freshness
 *     window (5 min) — null when nothing's live
 */
export interface StatbarSignals {
  burnRate: {
    /** USD per hour over the recent window. */
    costPerHour: number;
    /** Tokens per hour over the recent window. */
    tokensPerHour: number;
    /** How many minutes the window spans (e.g. 60). */
    windowMinutes: number;
    /** Records in the window — UI hides the ribbon when zero. */
    recordsInWindow: number;
  };
  cacheHitToday: {
    /** 0..1 — legacy read share: cacheRead / (input + cacheRead). */
    rate: number;
    /** 0..1 — cache reads divided by total canonical input, including writes. */
    canonicalRate?: number;
    /** Alias of rate, kept explicit for consumers comparing both denominators. */
    readShare?: number;
    /** 0..1 — uncached input divided by total canonical input. */
    missRate?: number;
    /** 0..1 — uncached input + cache writes divided by total canonical input. */
    freshInputShare?: number;
    /** 0..1 — cache writes divided by total canonical input. */
    cacheWriteShare?: number;
    /** Total cache-read tokens today. */
    cacheReadTokens: number;
    /** Total cache-write tokens today. */
    cacheWriteTokens?: number;
    /** Total non-cached input tokens today. */
    inputTokens: number;
    /** inputTokens + cacheWriteTokens. */
    freshInputTokens?: number;
    /** inputTokens + cacheReadTokens + cacheWriteTokens. */
    totalInputTokens?: number;
  };
  contextPressure: {
    /** Heuristic confidence/status for context drag in the latest active session. */
    status: "none" | "low" | "medium" | "high" | "critical";
    /** 0..1 — estimated share of the latest request that is session growth. */
    dragShare: number;
    /** Estimated carried-context growth since the session baseline. */
    dragTokens: number;
    /** Latest request's canonical total input: input + cacheRead + cacheWrite. */
    currentInputTokens: number;
    /** Early-session input baseline used as the comparison floor. */
    baselineInputTokens: number;
    /** Number of records in the active session group. */
    turnCount: number;
    /** Minutes between the first and latest record in the active session group. */
    sessionAgeMinutes: number;
    /** How Tokmeter grouped the records to infer the active session. */
    source: "sourceFile" | "project_provider_model" | "none";
    provider?: ProviderId;
    model?: string;
    project?: string;
    /** Context drag is not provider-exposed; Tokmeter estimates it. */
    provenance: Extract<UsageMetricProvenance, "estimated" | "not_exposed">;
    reason: string;
  };
  projectContextToday: Array<{
    project: string;
    /** 0..1 — cache reads divided by canonical total input today. */
    cacheHitRate: number;
    /** 0..1 — uncached input divided by canonical total input today. */
    missRate: number;
    /** 0..1 — uncached input + cache writes divided by canonical total input. */
    freshInputShare: number;
    /** 0..1 — cache writes divided by canonical total input. */
    cacheWriteShare: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    inputTokens: number;
    freshInputTokens: number;
    totalInputTokens: number;
    contextStatus: StatbarSignals["contextPressure"]["status"];
    dragShare: number;
    dragTokens: number;
    turnCount: number;
    lastUsed: number;
  }>;
  pace: {
    /** today.cost / typicalCostAtThisHour. null when we have no baseline. */
    multiple: number | null;
    /** USD typically spent by this hour-of-day (median across recent days). */
    typicalCostByNow: number;
    /** USD actually spent so far today. */
    actualCostByNow: number;
    /** How many past days informed the baseline. */
    daysOfHistory: number;
  };
  compactionToday: {
    cost: number;
    tokens: number;
    /** Compaction cost / total today cost, 0..1. 0 when no spend today. */
    share: number;
    /** Compaction events (records tagged kind:"compaction") today. */
    events: number;
  };
  reasoningToday: {
    /** Reasoning output tokens today (subset of outputTokens for OpenAI-style providers). */
    tokens: number;
    /** Total output tokens today — the denominator for share. */
    outputTokens: number;
    /** reasoningTokens / outputTokens, 0..1. 0 when no output today. */
    share: number;
    /** Records with reasoningTokens > 0 today — UI hides the chip when zero. */
    records: number;
  };
  /**
   * Today's subagent share. Claude Code's Task tool spawns subagents that
   * write to a separate JSONL. Surfacing this share tells the user how much
   * of their cost is going to nested agent work vs. main-session turns —
   * actionable for spotting runaway subagent loops or expensive parallel
   * fan-outs.
   */
  subagentToday: {
    /** USD attributed to subagent records today. */
    cost: number;
    /** Number of subagent records today. */
    records: number;
    /** cost / totalCost today, 0..1. 0 when no spend today. */
    share: number;
  };
  /**
   * Today's tool-call cost breakdown. Only Claude Code populates this today
   * (other providers don't expose tool names in their JSONL). When an
   * assistant turn fires multiple tools in parallel, the turn's cost is
   * split evenly across them — imperfect but the right call without
   * per-tool token accounting from the upstream API.
   */
  toolCallsToday: {
    /** Per-tool aggregates, sorted by cost descending. */
    byTool: Array<{
      /** Tool name as Claude Code wrote it ("Bash", "Read", "Edit", …). */
      tool: string;
      /** USD attributed to this tool today. */
      cost: number;
      /** cost / totalCost — UI uses this for bar widths. 0..1. */
      share: number;
      /** Number of times this tool was invoked today. */
      calls: number;
    }>;
    /** Total cost of today's tool-using turns. Denominator for share. */
    totalCost: number;
    /** Total tool invocations today (sum across all tools). */
    callCount: number;
    /** Distinct turns that fired ≥1 tool today. */
    turnsWithTools: number;
  };
  /**
   * Claude Pro/Max 5-hour billing window. A new block starts at the first
   * record after no Claude activity for >5h. Block ends 5h after its start.
   * null when there's no active block (no Claude records, or last block
   * expired). Only Claude has this billing model — other providers omit.
   */
  billingWindow: {
    /** 1-based count of blocks observed in the record set. */
    blockNumber: number;
    /** epoch ms — when the current block started. */
    blockStart: number;
    /** epoch ms — when the current block will end (blockStart + 5h). */
    blockEnd: number;
    /** Seconds until blockEnd. 0 when expired (UI should hide). */
    remainingSec: number;
    /** (now - blockStart) / 5h × 100, clamped to 0..100. */
    elapsedPct: number;
    /** USD spent in the current block. */
    cost: number;
    /** Total tokens (all kinds) in the current block. */
    tokens: number;
    /** Records in the current block — UI uses this to count turns/messages. */
    records: number;
  } | null;
  liveSession: {
    provider: ProviderId;
    model: string;
    project: string;
    /** Seconds since the most recent record's timestamp. */
    ageSeconds: number;
    /** Cost of the single most-recent record (for context-of-glance). */
    lastRecordCost: number;
  } | null;
}

/** Full serialisable summary payload used by web/CLI/API consumers. */
export interface TokmeterSummary {
  records: TokenRecord[];
  projects: ProjectSummary[];
  models: ModelSummary[];
  daily: DailyEntry[];
  stats: TokmeterStats;
  meta: ScanMeta;
  /** Optional — present when computed (daemon API includes it). */
  signals?: StatbarSignals;
}

/** Options for the TokmeterCore constructor. */
export interface TokmeterConfig {
  /** Home directory override (default: os.homedir()). */
  homeDir?: string;
  /** Cache directory for pricing data. */
  cacheDir?: string;
  /** Disable pricing calculation (faster scan). */
  skipPricing?: boolean;
}

/**
 * Optional hints a parser may honor to avoid reading the whole corpus.
 *
 * `modifiedSinceMs` is the big one: for a today-only scan there is no reason to
 * touch session files that haven't been written since midnight. Parsers that
 * respect it stat-prune their file list so a statusline/daemon "today" refresh
 * reads ~2 active files instead of months of history — the difference between
 * a 30 MB tick and a 2 GB one. Parsers may ignore it (correctness is
 * unaffected; they just stay on the slow path until updated).
 */
export interface ScanFilterOptions {
  /** Skip files whose mtime is strictly before this epoch-ms watermark. */
  modifiedSinceMs?: number;
}

/** The interface every session parser must implement. */
export interface SessionParser {
  /** Unique provider identifier. */
  readonly providerId: ProviderId;
  /** Scan local session files and return token records. */
  scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]>;
  /**
   * Optional memory-bounded variant: parse file-by-file, handing each file's
   * records to `onFile` so a caller (the relay rebuild) can fold + release them
   * instead of holding the whole corpus. Parsers that omit this fall back to
   * accumulating scan(); implement it for providers whose history is large
   * enough to matter (codex's fork-replay rollouts).
   */
  scanStreaming?(
    homeDir: string,
    opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void>;
}

// ─── Cleanup Types ──────────────────────────────────────────────────────────

/** The interface every provider cleaner must implement. */
export interface SessionCleaner {
  /** Provider this cleaner handles. */
  readonly providerId: ProviderId;
  /**
   * Given source files (from TokenRecord.sourceFile), resolve the full set
   * of filesystem targets to delete. For Claude Code this expands a .jsonl
   * to its 7 associated paths. For SQLite providers this returns row counts.
   */
  resolveTargets(sourceFiles: string[], homeDir: string): Promise<CleanupTarget[]>;
  /** Execute deletion of the resolved targets. */
  executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult>;
}

/** A single filesystem or database target to delete. */
export interface CleanupTarget {
  /** Absolute path to the file/directory, or DB path for SQLite providers. */
  path: string;
  /** Kind of target. */
  type: "file" | "directory" | "sqlite-rows" | "index-entry";
  /** Size in bytes (0 for sqlite-rows and index-entry). */
  sizeBytes: number;
  /** Provider this target belongs to. */
  provider: ProviderId;
  /** Human-readable label (e.g. "session transcript", "subagent dir"). */
  description: string;
  /** For sqlite-rows: details about the DELETE operation. */
  sqlDetail?: { table: string; whereClause: string; rowCount: number };
}

/** Filter criteria for cleanup operations. */
export interface CleanupFilter {
  /** Filter by project name/path substring. */
  project?: string;
  /** Filter by an exact set of selected project names. */
  projects?: string[];
  /** Filter by provider(s). */
  providers?: ProviderId[];
  /** Only records from this date onward (inclusive, YYYY-MM-DD or ISO). */
  since?: string;
  /** Only records up to this date (inclusive). */
  until?: string;
  /** Shortcut: today only. */
  today?: boolean;
  /** Shortcut: last 7 days. */
  week?: boolean;
  /** Shortcut: current calendar month. */
  month?: boolean;
}

/** Warning about a source file that has records both inside and outside the filter. */
export interface PartialFileWarning {
  /** The source file path. */
  file: string;
  /** Records matching the filter (will be deleted). */
  matchedRecords: number;
  /** Records outside the filter (will ALSO be lost). */
  otherRecords: number;
  /** Date range of the "other" records that will be collateral damage. */
  otherDateRange: string;
}

/** Result of a dry-run preview. */
export interface CleanupPreview {
  /** Number of records matching the filter. */
  recordCount: number;
  /** Unique source files that will be deleted or modified. */
  sourceFileCount: number;
  /** All resolved targets (files, dirs, DB rows). */
  targets: CleanupTarget[];
  /** Total bytes that will be freed. */
  totalBytes: number;
  /** Breakdown by provider. */
  byProvider: {
    provider: ProviderId;
    targets: number;
    bytes: number;
    records: number;
  }[];
  /** Breakdown by project. */
  byProject: {
    project: string;
    records: number;
    cost: number;
    tokens: number;
  }[];
  /** Transparency: files with records outside the filter that will also be lost. */
  partialFileWarnings: PartialFileWarning[];
}

/** Result after executing cleanup. */
export interface CleanupResult {
  /** Targets successfully deleted. */
  deletedCount: number;
  /** Targets that failed. */
  failedCount: number;
  /** Errors encountered during deletion. */
  errors: { target: string; error: string }[];
  /** Total bytes freed. */
  bytesFreed: number;
  /** Path to backup archive, if backup was requested. */
  backupPath?: string;
}

/** Options controlling cleanup execution. */
export interface CleanupOptions {
  /** Only preview — do not delete. */
  dryRun?: boolean;
  /** Create tar.gz backup before deleting (default: true). */
  backup?: boolean;
  /** Custom backup directory (default: ~/.cache/tokmeter/backups/). */
  backupDir?: string;
  /** Skip confirmation prompts (CLI). */
  force?: boolean;
}

/** Metadata stored alongside a backup archive. */
export interface BackupInfo {
  /** Unique backup identifier (timestamp-based). */
  id: string;
  /** Absolute path to the tar.gz file. */
  path: string;
  /** When the backup was created. */
  createdAt: string;
  /** Size of the archive in bytes. */
  sizeBytes: number;
  /** The filter used to create this backup. */
  filter: CleanupFilter;
  /** Number of records that were deleted. */
  recordCount: number;
  /** Providers affected. */
  providers: ProviderId[];
  /** Projects affected. */
  projects: string[];
  /**
   * Source machine's home directory at backup time (e.g. "/home/alice").
   * Used by restore to auto-remap paths when restoring on a machine with a
   * different homedir (cross-platform, different username, etc.).
   * Optional for backward compat with legacy backups.
   */
  sourceHomeDir?: string;
  /** Source machine's username at backup time. */
  sourceUser?: string;
  /** Source platform identifier ("linux", "darwin", "win32"). */
  sourcePlatform?: string;
}

/** Result of a restore operation. */
export interface RestoreResult {
  /** Number of files restored. */
  restoredCount: number;
  /** Errors encountered during restore. */
  errors: { file: string; error: string }[];
  /**
   * Count of UUIDs re-minted during cross-home restore because the target
   * path already existed on the destination machine. Each remap renames the
   * session's seven associated paths (transcript, subagents, file-history,
   * tasks, todos, session-env) consistently.
   */
  renamedCount?: number;
}
