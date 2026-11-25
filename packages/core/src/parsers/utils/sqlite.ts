/**
 * @sriinnu/tokmeter-core — Read-only SQLite driver loader and WAL stat helpers.
 */

import { stat } from "node:fs/promises";

/** Minimal read-only SQLite handle shared by the available runtime drivers. */
export interface ReadonlySqlite {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

/**
 * Wait briefly for a writer's lock instead of failing at once. Every driver
 * defaults to a 0 ms busy timeout, so a scan that lands while the owning app
 * (OpenCode, Cursor, …) holds a rollback-journal lock throws "database is
 * locked" and the parser silently reports nothing for that pass. Short on
 * purpose: these drivers are synchronous and block the daemon's event loop.
 */
function withBusyTimeout(db: ReadonlySqlite): ReadonlySqlite {
  try {
    db.get("PRAGMA busy_timeout = 1000");
  } catch {
    // Best effort — a driver that rejects the pragma still reads fine.
  }
  return db;
}

/**
 * Highest mtime across a SQLite database and its non-empty `-wal` sidecar
 * (returns `0` if the main database file is missing). Empty `-wal` files left
 * behind on macOS SQLite close are ignored so unchanged DBs stay skippable.
 */
export async function fileMtimeWithWal(dbPath: string): Promise<number> {
  let maxMtime = 0;
  try {
    maxMtime = (await stat(dbPath)).mtimeMs;
  } catch {
    return 0;
  }
  try {
    const wal = await stat(`${dbPath}-wal`);
    if (wal.size > 0 && wal.mtimeMs > maxMtime) maxMtime = wal.mtimeMs;
  } catch {
    /* no -wal */
  }
  return maxMtime;
}

/** Cache key combining size + mtime for a SQLite DB and its `-wal` sidecar. */
export async function dbFileStateKey(dbPath: string): Promise<string> {
  const one = async (p: string, requireNonEmpty = false) => {
    try {
      const s = await stat(p);
      if (requireNonEmpty && s.size === 0) return "-";
      return `${s.size}:${s.mtimeMs}`;
    } catch {
      return "-";
    }
  };
  return `${await one(dbPath)}|${await one(`${dbPath}-wal`, true)}`;
}

/**
 * Opens a SQLite database read-only, picking the right driver for the
 * runtime: `bun:sqlite` under Bun; under Node the built-in `node:sqlite`
 * (Node ≥ 22.5), then `better-sqlite3`.
 */
export async function openReadonlySqlite(path: string): Promise<ReadonlySqlite> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    try {
      // @ts-expect-error — bun:sqlite only resolves under the Bun runtime
      const { Database } = await import("bun:sqlite");
      const db = new Database(path, { readonly: true });
      return withBusyTimeout({
        get: (sql, ...params) => db.query(sql).get(...params) as never,
        all: (sql, ...params) => db.query(sql).all(...params) as never,
        close: () => db.close(),
      });
    } catch (error) {
      throw new Error(
        `Unable to open SQLite database ${path}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  let BuiltinDatabaseSync:
    | (new (
        path: string,
        opts: { readOnly: boolean }
      ) => {
        prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
        close(): void;
      })
    | undefined;
  try {
    // Specifier in a variable so bundlers and older type libs leave it alone.
    const builtin = "node:sqlite";
    ({ DatabaseSync: BuiltinDatabaseSync } = (await import(builtin)) as {
      DatabaseSync: NonNullable<typeof BuiltinDatabaseSync>;
    });
  } catch {
    BuiltinDatabaseSync = undefined;
  }
  if (BuiltinDatabaseSync) {
    try {
      const db = new BuiltinDatabaseSync(path, { readOnly: true });
      return withBusyTimeout({
        get: (sql, ...params) => db.prepare(sql).get(...params) as never,
        all: (sql, ...params) => db.prepare(sql).all(...params) as never,
        close: () => db.close(),
      });
    } catch (error) {
      throw new Error(
        `Unable to open SQLite database ${path}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  try {
    // @ts-expect-error — better-sqlite3 is an optional dependency
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path, { readonly: true });
    return withBusyTimeout({
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    });
  } catch (error) {
    throw new Error(
      `Unable to open SQLite database ${path}: ${error instanceof Error ? error.message : error}`
    );
  }
}
