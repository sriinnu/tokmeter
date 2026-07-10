/**
 * @sriinnu/tokmeter-core — Zed editor session parser.
 *
 * Zed's agent panel keeps one SQLite row per thread at
 * ~/Library/Application Support/Zed/threads/threads.db (macOS) — Linux and
 * Windows equivalents below. Unlike the other editor-integrated parsers in
 * this file, Zed is open source, so this schema comes straight from its
 * current source (not reverse-engineered):
 *   crates/agent/src/db.rs        — `threads` table + `DbThread`/`DataType`
 *   crates/language_model_core/…  — `TokenUsage` field names
 *   crates/agent/src/legacy_thread.rs — `SerializedLanguageModel {provider, model}`
 *   crates/util/src/path_list.rs  — `PathList::serialize()` ("\n"-joined paths)
 *
 * Each row's `data` column is a `data_type`-tagged blob: 'zstd' (zstd-
 * compressed JSON, the current format) or 'json' (legacy, uncompressed).
 * The decompressed JSON is `DbThread` flattened with a `version` field —
 * `cumulative_token_usage` and `model` are read directly off it. This
 * parser has not been validated against a live Zed install (not present on
 * the machine this was written on) — it's built from and tested against
 * Zed's real schema, but flag any discrepancy if Zed's format has moved.
 */

import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, fileExists, openReadonlySqlite } from "./utils.js";

const APP_DIR_CANDIDATES = [
  "Library/Application Support/Zed",
  ".local/share/zed",
  "AppData/Local/Zed",
];

interface ThreadRow {
  id: string;
  summary: string;
  updated_at: string;
  created_at?: string | null;
  data_type: "json" | "zstd";
  data: Uint8Array;
  folder_paths?: string | null;
}

interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

interface SerializedLanguageModel {
  provider?: string;
  model?: string;
}

interface DbThreadJson {
  cumulative_token_usage?: TokenUsage;
  model?: SerializedLanguageModel;
}

function decodeThreadData(row: ThreadRow): DbThreadJson | null {
  try {
    const json =
      row.data_type === "zstd"
        ? zstdDecompressSync(Buffer.from(row.data)).toString("utf-8")
        : Buffer.from(row.data).toString("utf-8");
    return JSON.parse(json) as DbThreadJson;
  } catch {
    return null;
  }
}

function resolveProject(folderPaths: string | null | undefined): string {
  if (!folderPaths) return "zed";
  // folder_paths is PathList::serialize().paths: a "\n"-joined list of
  // absolute workspace root paths, lexicographically sorted. Any one of
  // them identifies the project.
  const first = folderPaths.split("\n")[0]?.trim();
  return first ? canonicalizeProjectName(first, "zed") : "zed";
}

export class ZedParser implements SessionParser {
  readonly providerId = "zed" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    for (const appDir of APP_DIR_CANDIDATES) {
      const dbPath = join(expandHome(`~/${appDir}`, homeDir), "threads", "threads.db");
      if (!(await fileExists(dbPath))) continue;

      const db = await openReadonlySqlite(dbPath);
      if (!db) continue;

      try {
        const rows = db.all<ThreadRow>(
          "SELECT id, summary, updated_at, created_at, data_type, data, folder_paths FROM threads"
        );

        for (const row of rows) {
          const thread = decodeThreadData(row);
          if (!thread) continue;

          const usage = thread.cumulative_token_usage;
          const inputTokens = usage?.input_tokens ?? 0;
          const outputTokens = usage?.output_tokens ?? 0;
          const cacheReadTokens = usage?.cache_read_input_tokens ?? 0;
          const cacheWriteTokens = usage?.cache_creation_input_tokens ?? 0;
          // A thread with no usage recorded yet (still open, or predates
          // token tracking) isn't a billable event — skip rather than
          // emit an all-zero record.
          if (inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens === 0) continue;

          records.push(
            createRecord({
              timestamp: new Date(row.created_at || row.updated_at).getTime() || Date.now(),
              provider: "zed",
              model: thread.model?.model || "unknown",
              project: resolveProject(row.folder_paths),
              sourceFile: dbPath,
              inputTokens,
              outputTokens,
              cacheReadTokens,
              cacheWriteTokens,
            })
          );
        }
      } catch {
        // Zed's schema moved — fail soft rather than crash the scan
      } finally {
        db.close();
      }
    }
    return records;
  }
}
