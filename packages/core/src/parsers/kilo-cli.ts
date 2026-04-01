/**
 * @sriinnu/tokmeter-core — Kilo CLI session parser.
 *
 * Reads from ~/.local/share/kilo/kilo.db (SQLite, fork of OpenCode).
 */

import type { SessionParser, TokenRecord } from "../types.js";
import { expandHome, fileExists } from "./utils.js";

export class KiloCliParser implements SessionParser {
  readonly providerId = "kilo-cli" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const dbPath = expandHome("~/.local/share/kilo/kilo.db", homeDir);

    // SQLite parsing requires better-sqlite3 dependency
    // For now, return empty — can be enhanced with optional SQLite dep
    // Similar to OpenCode's SQLite path
    if (!(await fileExists(dbPath))) return [];

    // TODO: Add SQLite parsing when better-sqlite3 is available
    return [];
  }
}
