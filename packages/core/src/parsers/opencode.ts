/**
 * @tokmeter/core — OpenCode session parser.
 *
 * Reads from ~/.local/share/opencode/opencode.db (SQLite, v1.2+)
 * or ~/.local/share/opencode/storage/message/ (legacy JSON).
 */

import type { TokenRecord, SessionParser } from "../types.js";
import {
  expandHome,
  findFiles,
  readJsonFile,
  createRecord,
  fileExists,
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

export class OpenCodeParser implements SessionParser {
  readonly providerId = "opencode" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    // Try SQLite first (v1.2+) — requires better-sqlite3 or similar optional dep
    const dbPath = expandHome("~/.local/share/opencode/opencode.db", homeDir);
    try {
      // @ts-ignore — better-sqlite3 is optional
      const { default: Database } = await import("better-sqlite3");
      if (await fileExists(dbPath)) {
        const db = new Database(dbPath, { readonly: true });
        try {
          const rows = db.prepare(
            "SELECT model_id, provider_id, input_tokens, output_tokens, reasoning_tokens, cache_read, cache_write, created_at FROM messages WHERE role = 'assistant'",
          ).all() as Array<{
            model_id?: string;
            provider_id?: string;
            input_tokens?: number;
            output_tokens?: number;
            reasoning_tokens?: number;
            cache_read?: number;
            cache_write?: number;
            created_at?: number;
          }>;
          for (const row of rows) {
            records.push(
              createRecord({
                timestamp: row.created_at ?? Date.now(),
                provider: "opencode",
                model: row.model_id || "unknown",
                project: "opencode",
                inputTokens: row.input_tokens ?? 0,
                outputTokens: row.output_tokens ?? 0,
                reasoningTokens: row.reasoning_tokens ?? 0,
                cacheReadTokens: row.cache_read ?? 0,
                cacheWriteTokens: row.cache_write ?? 0,
              }),
            );
          }
        } finally {
          db.close();
        }
        return records;
      }
    } catch {
      // better-sqlite3 not available or DB read failed — fall through to legacy JSON
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
        }),
      );
    }
    return records;
  }
}
