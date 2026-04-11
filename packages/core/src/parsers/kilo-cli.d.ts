/**
 * @sriinnu/tokmeter-core — Kilo CLI session parser.
 *
 * Reads from ~/.local/share/kilo/kilo.db (SQLite, fork of OpenCode).
 * Kilo CLI shares the same database schema as OpenCode — a `messages` table
 * with per-message token breakdowns and an optional `sessions` table for
 * project/path context.
 *
 * Requires `better-sqlite3` as an optional peer dependency. If the dep
 * isn't installed, we gracefully return an empty array.
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class KiloCliParser implements SessionParser {
  readonly providerId: "kilo-cli";
  scan(homeDir: string): Promise<TokenRecord[]>;
  /**
   * Queries the `messages` table for assistant responses and maps each row
   * to a TokenRecord. If a `sessions` table exists, we join on session_id
   * to extract project paths.
   */
  private readMessages;
  /**
   * Attempts to load project paths from a `sessions` table.
   * Returns a Map<session_id, project_name>. If the table doesn't exist
   * (schema variation), returns an empty map — no error.
   */
  private loadSessionProjects;
}
