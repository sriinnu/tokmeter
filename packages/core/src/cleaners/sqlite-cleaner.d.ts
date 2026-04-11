/**
 * @sriinnu/tokmeter-core — SQLite cleaner.
 *
 * For providers that store data in SQLite (opencode, kilo-cli).
 * Uses optional better-sqlite3 dependency (same as the parsers).
 * Deletes matching rows via DELETE + VACUUM.
 */
import type { CleanupResult, CleanupTarget, ProviderId, SessionCleaner } from "../types.js";
interface SqliteCleanerConfig {
  providerId: ProviderId;
  dbPath: (homeDir: string) => string;
  table: string;
  timestampColumn: string;
  /** Optional: column to filter by session/project (joined from sessions table). */
  sessionColumn?: string;
}
export declare class SqliteCleaner implements SessionCleaner {
  readonly providerId: ProviderId;
  private config;
  constructor(config: SqliteCleanerConfig);
  resolveTargets(_sourceFiles: string[], homeDir: string): Promise<CleanupTarget[]>;
  /**
   * Export matching rows to a JSON file before deletion so they can be backed up.
   * Returns the path to the dump file, or null if export fails or no rows.
   */
  exportRows(target: CleanupTarget, backupDir: string): Promise<string | null>;
  executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult>;
  private loadSqlite;
}
/** Factory: create SQLite cleaners for opencode and kilo-cli. */
export declare function createSqliteCleaners(): SqliteCleaner[];
