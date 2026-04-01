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
