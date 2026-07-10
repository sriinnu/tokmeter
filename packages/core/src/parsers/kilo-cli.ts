/**
 * @sriinnu/tokmeter-core — Kilo CLI session parser.
 *
 * Reads from ~/.local/share/kilo/kilo.db (SQLite, fork of OpenCode).
 * Kilo CLI shares the same database schema as OpenCode — a `messages` table
 * with per-message token breakdowns and an optional `sessions` table for
 * project/path context.
 *
 * Reads the SQLite file via bun:sqlite (Bun) or better-sqlite3 (Node),
 * whichever is available — see openReadonlySqlite in utils.ts. Gracefully
 * returns an empty array if neither driver is available.
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import {
  type ReadonlySqlite,
  createRecord,
  expandHome,
  fileExists,
  openReadonlySqlite,
} from "./utils.js";

/** Shape of a row from the `messages` table (assistant responses only). */
interface KiloMessageRow {
  model_id?: string;
  provider_id?: string;
  input_tokens?: number;
  output_tokens?: number;
  reasoning_tokens?: number;
  cache_read?: number;
  cache_write?: number;
  created_at?: number;
  session_id?: string;
}

/** Shape of a row from the `sessions` table (if it exists). */
interface KiloSessionRow {
  id: string;
  title?: string;
  path?: string;
  cwd?: string;
}

export class KiloCliParser implements SessionParser {
  readonly providerId = "kilo-cli" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const dbPath = expandHome("~/.local/share/kilo/kilo.db", homeDir);

    if (!(await fileExists(dbPath))) return [];

    const db = await openReadonlySqlite(dbPath);
    if (!db) return [];

    try {
      return this.readMessages(db, dbPath);
    } catch {
      return [];
    } finally {
      db.close();
    }
  }

  /**
   * Queries the `messages` table for assistant responses and maps each row
   * to a TokenRecord. If a `sessions` table exists, we join on session_id
   * to extract project paths.
   */
  private readMessages(db: ReadonlySqlite, dbPath: string): TokenRecord[] {
    const records: TokenRecord[] = [];

    // Build a session-id -> project-path lookup if the sessions table exists
    const sessionProjects = this.loadSessionProjects(db);

    const rows = db.all<KiloMessageRow>(
      `SELECT model_id, provider_id, input_tokens, output_tokens,
              reasoning_tokens, cache_read, cache_write, created_at,
              session_id
       FROM messages
       WHERE role = 'assistant'`
    );

    for (const row of rows) {
      // Resolve project from session path, falling back to "kilo-cli"
      const project = (row.session_id && sessionProjects.get(row.session_id)) || "kilo-cli";

      records.push(
        createRecord({
          timestamp: row.created_at ?? Date.now(),
          provider: "kilo-cli",
          model: row.model_id || "unknown",
          project,
          sourceFile: dbPath,
          inputTokens: row.input_tokens ?? 0,
          outputTokens: row.output_tokens ?? 0,
          reasoningTokens: row.reasoning_tokens ?? 0,
          cacheReadTokens: row.cache_read ?? 0,
          cacheWriteTokens: row.cache_write ?? 0,
        })
      );
    }

    return records;
  }

  /**
   * Attempts to load project paths from a `sessions` table.
   * Returns a Map<session_id, project_name>. If the table doesn't exist
   * (schema variation), returns an empty map — no error.
   */
  private loadSessionProjects(db: ReadonlySqlite): Map<string, string> {
    const map = new Map<string, string>();

    try {
      // Check if the sessions table exists before querying
      const tableCheck = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      );

      if (!tableCheck) return map;

      // Try path first, then cwd, then title — different forks may use different columns
      const rows = db.all<KiloSessionRow>("SELECT id, title, path, cwd FROM sessions");

      for (const row of rows) {
        const project = row.path || row.cwd || row.title || undefined;
        if (project) {
          map.set(row.id, canonicalizeProjectName(project, "kilo-cli"));
        }
      }
    } catch {
      // Sessions table missing or has a different schema — that's fine,
      // we'll just use the default "kilo-cli" project name
    }

    return map;
  }
}
