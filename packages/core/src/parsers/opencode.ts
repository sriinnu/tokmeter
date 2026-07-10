/**
 * @sriinnu/tokmeter-core — OpenCode session parser.
 *
 * Reads from ~/.local/share/opencode/opencode.db (SQLite, v1.2+)
 * or ~/.local/share/opencode/storage/message/ (legacy JSON).
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import {
  type ReadonlySqlite,
  createRecord,
  expandHome,
  fileExists,
  findFiles,
  openReadonlySqlite,
  readJsonFile,
} from "./utils.js";

interface OpenCodeMessage {
  id?: string;
  role?: string;
  modelID?: string;
  providerID?: string;
  tokens?: {
    input?: number;
    output?: number;
    reasoning?: number;
    cache?: { read?: number; write?: number };
  };
  time?: { created?: number };
}

interface OpenCodeMessageRow {
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

interface OpenCodeSessionRow {
  id: string;
  title?: string;
  path?: string;
  cwd?: string;
}

export class OpenCodeParser implements SessionParser {
  readonly providerId = "opencode" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    // Try SQLite first (v1.2+) — via bun:sqlite or better-sqlite3, whichever
    // the runtime supports (see openReadonlySqlite in utils.ts)
    const dbPath = expandHome("~/.local/share/opencode/opencode.db", homeDir);
    if (await fileExists(dbPath)) {
      const db = await openReadonlySqlite(dbPath);
      if (db) {
        try {
          const sessionProjects = this.loadSessionProjects(db);
          const rows = db.all<OpenCodeMessageRow>(
            "SELECT model_id, provider_id, input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, created_at, session_id FROM messages WHERE role = 'assistant'"
          );
          for (const row of rows) {
            const project = (row.session_id && sessionProjects.get(row.session_id)) || "opencode";

            records.push(
              createRecord({
                timestamp: row.created_at ?? Date.now(),
                provider: "opencode",
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
        } catch {
          // DB read failed (schema drift) — fall through to legacy JSON
        } finally {
          db.close();
        }
      }
    }

    // Legacy JSON format
    const storageDir = expandHome("~/.local/share/opencode/storage/message", homeDir);
    const jsonFiles = await findFiles(storageDir, (f) => f.endsWith(".json"), 3);

    for (const file of jsonFiles) {
      const msg = await readJsonFile<OpenCodeMessage>(file);
      if (!msg || msg.role !== "assistant" || !msg.tokens) continue;

      records.push(
        createRecord({
          timestamp: msg.time?.created ?? Date.now(),
          provider: "opencode",
          model: msg.modelID || "unknown",
          project: "opencode",
          sourceFile: file,
          inputTokens: msg.tokens.input ?? 0,
          outputTokens: msg.tokens.output ?? 0,
          reasoningTokens: msg.tokens.reasoning ?? 0,
          cacheReadTokens: msg.tokens.cache?.read ?? 0,
          cacheWriteTokens: msg.tokens.cache?.write ?? 0,
          usage: { source: "tool_json" },
        })
      );
    }
    return records;
  }

  private loadSessionProjects(db: ReadonlySqlite): Map<string, string> {
    const map = new Map<string, string>();

    try {
      const tableCheck = db.get<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'"
      );

      if (!tableCheck) {
        return map;
      }

      const rows = db.all<OpenCodeSessionRow>("SELECT id, title, path, cwd FROM sessions");

      for (const row of rows) {
        const project = row.path || row.cwd || row.title || undefined;
        if (project) {
          map.set(row.id, canonicalizeProjectName(project, "opencode"));
        }
      }
    } catch {
      return map;
    }

    return map;
  }
}
