/**
 * @sriinnu/tokmeter-core — Kilo CLI session parser.
 *
 * Reads from ~/.local/share/kilo/kilo.db (SQLite, fork of OpenCode). Kilo CLI
 * shares OpenCode's database schema, so the schema handling — current JSON
 * `message.data` rows and the older flat `messages` table — lives in
 * opencode-db.ts.
 *
 * Reads the SQLite file via bun:sqlite (Bun) or better-sqlite3 (Node),
 * whichever is available — see openReadonlySqlite in utils.ts. Gracefully
 * returns an empty array if neither driver is available.
 */

import type { SessionParser, TokenRecord } from "../types.js";
import { readOpenCodeDb } from "./opencode-db.js";
import { expandHome, fileExists, openReadonlySqlite } from "./utils.js";

export class KiloCliParser implements SessionParser {
  readonly providerId = "kilo-cli" as const;

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.local/share/kilo/kilo.db", homeDir)];
  }

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const [dbPath] = this.sessionRoots(homeDir);

    if (!(await fileExists(dbPath))) return [];

    const db = await openReadonlySqlite(dbPath);
    try {
      return readOpenCodeDb(db, dbPath, "kilo-cli");
    } finally {
      db.close();
    }
  }
}
