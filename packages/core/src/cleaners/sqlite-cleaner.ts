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

export class SqliteCleaner implements SessionCleaner {
  readonly providerId: ProviderId;
  private config: SqliteCleanerConfig;

  constructor(config: SqliteCleanerConfig) {
    this.providerId = config.providerId;
    this.config = config;
  }

  async resolveTargets(
    sourceFiles: string[],
    homeDir: string,
  ): Promise<CleanupTarget[]> {
    // For SQLite providers, sourceFile points to the .db file itself.
    // We count rows that would be deleted rather than deleting the file.
    const dbPath = this.config.dbPath(homeDir);
    const targets: CleanupTarget[] = [];

    try {
      const Database = await this.loadSqlite();
      if (!Database) return targets;

      const db = new Database(dbPath, { readonly: true });
      const countResult = db.prepare(
        `SELECT COUNT(*) as cnt FROM ${this.config.table} WHERE role = 'assistant'`,
      ).get() as { cnt: number } | undefined;

      const rowCount = countResult?.cnt ?? 0;
      db.close();

      if (rowCount > 0) {
        targets.push({
          path: dbPath,
          type: "sqlite-rows",
          sizeBytes: 0,
          provider: this.providerId,
          description: `${rowCount} assistant rows in ${this.config.table}`,
          sqlDetail: {
            table: this.config.table,
            whereClause: "role = 'assistant'",
            rowCount,
          },
        });
      }
    } catch {
      // DB not available or better-sqlite3 not installed
    }

    return targets;
  }

  async executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult> {
    let deletedCount = 0;
    const errors: { target: string; error: string }[] = [];

    for (const t of targets) {
      if (t.type !== "sqlite-rows" || !t.sqlDetail) continue;

      try {
        const Database = await this.loadSqlite();
        if (!Database) {
          errors.push({ target: t.path, error: "better-sqlite3 not available" });
          continue;
        }

        const db = new Database(t.path);
        const result = db.prepare(
          `DELETE FROM ${t.sqlDetail.table} WHERE ${t.sqlDetail.whereClause}`,
        ).run();

        // Reclaim disk space
        db.pragma("wal_checkpoint(TRUNCATE)");
        db.exec("VACUUM");
        db.close();

        deletedCount += result.changes;
      } catch (err) {
        errors.push({
          target: t.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return {
      deletedCount,
      failedCount: errors.length,
      errors,
      bytesFreed: 0, // SQLite VACUUM reclaims space but we can't easily measure it
    };
  }

  private async loadSqlite(): Promise<any> {
    try {
      // @ts-ignore — better-sqlite3 is an optional dependency
      const { default: Database } = await import("better-sqlite3");
      return Database;
    } catch {
      return null;
    }
  }
}

/** Factory: create SQLite cleaners for opencode and kilo-cli. */
export function createSqliteCleaners(): SqliteCleaner[] {
  return [
    new SqliteCleaner({
      providerId: "opencode",
      dbPath: (home) => `${home}/.local/share/opencode/opencode.db`,
      table: "messages",
      timestampColumn: "created_at",
    }),
    new SqliteCleaner({
      providerId: "kilo-cli",
      dbPath: (home) => `${home}/.local/share/kilo/kilo.db`,
      table: "messages",
      timestampColumn: "created_at",
    }),
  ];
}
