/**
 * @sriinnu/tokmeter-core — CleanupService.
 *
 * Orchestrates preview, backup, execute, and restore for session cleanup.
 * Does NOT modify TokmeterCore (keeps it read-only). Accepts a core instance.
 */
import type { TokmeterCore } from "./tokmeter-core.js";
import type {
  BackupInfo,
  CleanupFilter,
  CleanupOptions,
  CleanupPreview,
  CleanupResult,
  RestoreResult,
} from "./types.js";
export declare class CleanupService {
  private core;
  private homeDir;
  constructor(core: TokmeterCore, homeDir?: string);
  /**
   * Preview what would be deleted. Scans all records, applies filters,
   * resolves filesystem targets, and detects partial file collateral.
   */
  preview(filter: CleanupFilter): Promise<CleanupPreview>;
  /**
   * Execute cleanup: optionally backup, then delete, then invalidate cache.
   */
  execute(filter: CleanupFilter, options?: CleanupOptions): Promise<CleanupResult>;
  /** List available backups. */
  listBackups(backupDir?: string): BackupInfo[];
  /** Restore from a backup archive. */
  restore(backupId: string, backupDir?: string): RestoreResult;
  private applyFilter;
  /**
   * Detect source files where some records match the filter but others don't.
   * These files will be fully deleted, causing collateral data loss — user must be warned.
   */
  private detectPartialFiles;
  private buildProviderBreakdown;
  private buildProjectBreakdown;
  /**
   * Create a tar.gz backup of all targets (files + SQLite row exports).
   * Writes both the archive and a .meta.json sidecar.
   */
  private createBackup;
}
