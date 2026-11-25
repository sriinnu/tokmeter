/**
 * Shared SQLite helper for unit/integration tests.
 * Uses Node's built-in `node:sqlite` so tests run identically on POSIX and
 * Windows without requiring a separate `sqlite3` CLI executable.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Execute SQLite statements (with optional positional bind params) in a test database. */
export function execSql(dbPath: string, sql: string, params?: unknown[]): void {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (
      path: string
    ) => {
      exec(sql: string): void;
      prepare(sql: string): { run(...args: unknown[]): unknown };
      close(): void;
    };
  };
  const db = new DatabaseSync(dbPath);
  try {
    if (params && params.length > 0) {
      db.prepare(sql).run(...params);
    } else {
      db.exec(sql);
    }
  } finally {
    db.close();
  }
}
