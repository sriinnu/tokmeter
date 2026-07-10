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
 *   crates/util/src/path_list.rs  — `PathList::serialize()` (lexicographic
 *     "\n"-joined paths + a separate comma-joined `order` column giving each
 *     path's original, pre-sort position)
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
  folder_paths_order?: string | null;
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

/**
 * folder_paths is stored lexicographically sorted, NOT in the order the
 * user opened them — the original order lives in the separate
 * folder_paths_order column (comma-joined indices into the lexicographic
 * list). Picking folder_paths[0] directly would silently bucket usage
 * under an arbitrary alphabetically-first root in a multi-root workspace
 * (e.g. "docs/" ahead of the actual project). Reconstruct the originally-
 * first path when the order column is present; fall back to the
 * lexicographic first for single-root workspaces or malformed order data.
 */
function resolveProject(
  folderPaths: string | null | undefined,
  folderPathsOrder: string | null | undefined
): string {
  if (!folderPaths) return "zed";
  const paths = folderPaths.split("\n");

  if (folderPathsOrder) {
    const order = folderPathsOrder.split(",").map(Number);
    if (order.length === paths.length && order.every((n) => Number.isInteger(n))) {
      const firstIndex = order.indexOf(Math.min(...order));
      const originalFirst = paths[firstIndex]?.trim();
      if (originalFirst) return canonicalizeProjectName(originalFirst, "zed");
    }
  }

  const first = paths[0]?.trim();
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
          "SELECT id, summary, updated_at, created_at, data_type, data, folder_paths, folder_paths_order FROM threads"
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
              // cumulative_token_usage is the thread's running total "as of
              // its latest save" — updated_at, not created_at (which Zed
              // preserves unchanged across every subsequent save of a
              // reused thread). Using created_at would dump a long-lived
              // thread's entire current total onto the day it was first
              // opened, and show $0 on every day it was actually used again.
              timestamp:
                new Date(row.updated_at || row.created_at || Date.now()).getTime() || Date.now(),
              provider: "zed",
              model: thread.model?.model || "unknown",
              project: resolveProject(row.folder_paths, row.folder_paths_order),
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
