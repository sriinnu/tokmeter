/**
 * @sriinnu/tokmeter-core — Main TokmeterCore class.
 *
 * Public API for scanning, aggregating, and querying token usage.
 * Consumable by CLI, TUI, web app, macOS bar, and external projects.
 */
import type {
  DailyEntry,
  ModelSummary,
  ProjectSummary,
  ScanMeta,
  ScanOptions,
  TokenRecord,
  TokmeterConfig,
  TokmeterStats,
  TokmeterSummary,
} from "./types.js";
export declare class TokmeterCore {
  private records;
  private pricing;
  private homeDir;
  private skipPricing;
  private scanMeta;
  constructor(config?: TokmeterConfig);
  /**
   * Scan all session files and build token usage records.
   * This is the main entry point — call this first.
   *
   * @param options - Filter and provider options for the scan.
   * @returns Array of parsed token usage records.
   */
  scan(options?: ScanOptions): Promise<TokenRecord[]>;
  /** Get all loaded records. */
  getRecords(): TokenRecord[];
  /** Metadata describing the last scan's stable/live composition state. */
  getScanMeta(): ScanMeta;
  /** Get summaries for all projects. */
  getAllProjects(): ProjectSummary[];
  /** Get summary for a specific project (by exact name or substring match). */
  getProjectSummary(projectName: string): ProjectSummary | undefined;
  /** Get model summaries, optionally filtered by project. */
  getModelCosts(options?: {
    project?: string;
  }): ModelSummary[];
  /** Get provider breakdown across all records. */
  getProviderBreakdown(): import("./types.js").ProviderSummary[];
  /** Get daily breakdown, optionally filtered by date range and project. */
  getDailyBreakdown(options?: {
    since?: string;
    until?: string;
    project?: string;
  }): DailyEntry[];
  /**
   * Get overall stats — computed in a single pass over all records.
   *
   * Returns totals, unique counts, and longest activity streak.
   */
  getStats(): TokmeterStats;
  /** Get a serialisable summary payload with data plus scan metadata. */
  getSummary(): TokmeterSummary;
  /**
   * Export everything as a JSON-serialisable object.
   *
   * The output shape matches what the web app and macOS bar expect.
   */
  toJSON(): TokmeterSummary;
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
  private enrichCosts;
  private scanHistoricalRecords;
  private scanTodayRecords;
  private scanRawRecords;
  private resolveTodayState;
  private toErrorMessage;
}
