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
// Namespace import: zstd is Node 22.15+, and a named import of it fails at
// module load on older Node, taking every command down with it. There, a
// zstd row throws inside decodeThreadData and is skipped like a corrupt one.
import * as zlib from "node:zlib";
import { localDateKey } from "../date-utils.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { dayDelta, readBaselines, writeBaselines } from "./cumulative-baselines.js";
import {
  createRecord,
  expandHome,
  fileExists,
  getConfiguredProviderPaths,
  openReadonlySqlite,
} from "./utils.js";

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
        ? zlib.zstdDecompressSync(Buffer.from(row.data)).toString("utf-8")
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

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [
      ...APP_DIR_CANDIDATES.map((d) => expandHome(`~/${d}`, homeDir)),
      ...getConfiguredProviderPaths("zed", homeDir).map((p) => expandHome(p, homeDir)),
    ].map((appDir) => join(appDir, "threads", "threads.db"));
  }

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const baselines = readBaselines(homeDir);
    const changed = { value: false };

    for (const dbPath of this.sessionRoots(homeDir)) {
      if (!(await fileExists(dbPath))) continue;

      const db = await openReadonlySqlite(dbPath);
      try {
        const rows = db.all<ThreadRow>(
          "SELECT id, summary, updated_at, created_at, data_type, data, folder_paths, folder_paths_order FROM threads"
        );

        for (const row of rows) {
          const thread = decodeThreadData(row);
          if (!thread) continue;

          const usage = thread.cumulative_token_usage;
          const current = {
            inputTokens: usage?.input_tokens ?? 0,
            outputTokens: usage?.output_tokens ?? 0,
            cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
            reasoningTokens: 0,
          };
          // cumulative_token_usage is the thread's running total "as of its
          // latest save", so it belongs to updated_at (created_at is kept
          // unchanged across every later save of a reused thread). Only the
          // growth since that day began is that day's usage; emitting the
          // whole total counted a long thread's history again every day it
          // was touched. See cumulative-baselines.ts.
          const updatedMs = new Date(row.updated_at || row.created_at || "").getTime();
          if (!Number.isFinite(updatedMs)) continue;
          const createdMs = row.created_at ? new Date(row.created_at).getTime() : Number.NaN;
          const delta = dayDelta(
            baselines,
            `zed:${dbPath}#${row.id}`,
            localDateKey(updatedMs),
            current,
            Number.isFinite(createdMs) ? localDateKey(createdMs) : undefined,
            changed
          );
          if (!delta) continue;

          records.push(
            createRecord({
              timestamp: updatedMs,
              provider: "zed",
              model: thread.model?.model || "unknown",
              project: resolveProject(row.folder_paths, row.folder_paths_order),
              sourceFile: dbPath,
              threadKey: row.id,
              inputTokens: delta.inputTokens,
              outputTokens: delta.outputTokens,
              cacheReadTokens: delta.cacheReadTokens,
              cacheWriteTokens: delta.cacheWriteTokens,
            })
          );
        }
      } finally {
        db.close();
      }
    }
    if (changed.value) writeBaselines(baselines, homeDir);
    return records;
  }
}
