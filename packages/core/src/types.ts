/**
 * @sriinnu/tokmeter-core — Shared type definitions.
 */

/** Provider identifiers for all supported AI coding agents. */
export type ProviderId =
  | "claude-code"
  | "opencode"
  | "codex"
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
  | "synthetic";

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
  /** Original session file path (for debugging). */
  sourceFile?: string;
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
  /** Whether frozen history came from cache, rebuild, or is unavailable. */
  historySource: "snapshot" | "rebuilt" | "none";
  /** Current state of today's overlay data. */
  todayState: "live" | "degraded" | "snapshot-only";
  /** Epoch ms of the last completed scan. */
  lastScanAt: number;
  /** Non-fatal warnings gathered during scan/caching. */
  warnings: ScanWarning[];
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

/** Full serialisable summary payload used by web/CLI/API consumers. */
export interface TokmeterSummary {
  records: TokenRecord[];
  projects: ProjectSummary[];
  models: ModelSummary[];
  daily: DailyEntry[];
  stats: TokmeterStats;
  meta: ScanMeta;
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

/** The interface every session parser must implement. */
export interface SessionParser {
  /** Unique provider identifier. */
  readonly providerId: ProviderId;
  /** Scan local session files and return token records. */
  scan(homeDir: string): Promise<TokenRecord[]>;
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
