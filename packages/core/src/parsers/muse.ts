/**
 * @sriinnu/tokmeter-core — Muse (Meta's coding agent) session parser.
 *
 * Reads from ~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl
 *
 * Muse writes an event-sourced log: one flat JSON record per line, each with a
 * stable `id`, a microsecond `recorded_at`, a `payload_type`, and a `payload`.
 * Token usage lives on the `event.kind === "model_completed"` records:
 *
 *   payload.event = {
 *     kind: "model_completed",
 *     usage: { input_tokens, output_tokens, cached_tokens,
 *              cache_read_tokens, cache_write_tokens, reasoning_tokens },
 *     model: "muse-spark-1.3"
 *   }
 *
 * One `model_completed` record == one API response, so the record's own `id`
 * is the dedup key. The same usage is ALSO echoed on `goal_usage_attribution`
 * / `usage_family:"provider"` records — those are a parallel attribution view
 * of the same spend, so we count ONLY `model_completed` or we double-bill.
 *
 * Muse reports OpenAI-style: `input_tokens` is the FULL prompt and INCLUDES
 * `cache_read_tokens` (mirrored as `cached_tokens`). We subtract the cached
 * portion so inputTokens = uncached only, matching Anthropic semantics and the
 * gemini parser, so the cost calculator never charges cached tokens at the
 * full input rate.
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

interface MuseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

interface MuseRecord {
  id?: string;
  recorded_at?: number; // microseconds since epoch
  payload_type?: string;
  payload?: {
    kind?: string;
    event?: {
      kind?: string;
      usage?: MuseUsage;
      model?: string;
    };
    record?: {
      workspace_root?: string;
    };
  };
}

export class MuseParser implements SessionParser {
  readonly providerId = "muse" as const;

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const out: TokenRecord[] = [];
    await this.scanStreaming(homeDir, opts, (records) => {
      out.push(...records);
    });
    return out;
  }

  async scanStreaming(
    homeDir: string,
    _opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void> {
    const sessionsDir = expandHome("~/.local/share/muse/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f.endsWith("session.jsonl"), 6);

    for (const file of files) {
      const records = await this.parseFile(file);
      if (records.length > 0) await onFile(records);
    }
  }

  private async parseFile(file: string): Promise<TokenRecord[]> {
    const lines = await readJsonlFile<MuseRecord>(file);
    const records: TokenRecord[] = [];
    const seenIds = new Set<string>();
    let workspaceRoot: string | undefined;

    for (const rec of lines) {
      // Capture the session's workspace once — it arrives on a
      // runtime.session.metadata record, not on the usage records.
      if (!workspaceRoot && rec.payload?.record?.workspace_root) {
        workspaceRoot = rec.payload.record.workspace_root;
      }

      const event = rec.payload?.event;
      if (event?.kind !== "model_completed" || !event.usage) continue;

      // Dedup on the record id — one model_completed == one API response.
      const id = rec.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }

      const u = event.usage;
      const totalInput = u.input_tokens ?? 0;
      // `cached_tokens` mirrors `cache_read_tokens` in observed data, but take
      // the max rather than `??` so an explicit `cache_read_tokens: 0` alongside
      // a populated `cached_tokens` still strips the cached portion (otherwise
      // those tokens get billed at the full input rate).
      const cacheRead = Math.max(u.cache_read_tokens ?? 0, u.cached_tokens ?? 0);
      // input_tokens includes the cached portion (OpenAI-style) — strip it.
      const inputTokens = Math.max(0, totalInput - cacheRead);

      const ts =
        typeof rec.recorded_at === "number" && Number.isFinite(rec.recorded_at)
          ? Math.round(rec.recorded_at / 1000)
          : Date.now();

      records.push(
        createRecord({
          timestamp: ts,
          provider: "muse",
          model: event.model || "muse-spark-1.3",
          project: workspaceRoot ? canonicalizeProjectName(workspaceRoot, "muse") : "muse",
          cwd: workspaceRoot,
          sourceFile: file,
          apiCallId: id,
          inputTokens,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: u.cache_write_tokens ?? 0,
          reasoningTokens: u.reasoning_tokens ?? 0,
        })
      );
    }

    // workspace_root can appear AFTER the first model_completed; backfill the
    // project for any records emitted before we saw it.
    if (workspaceRoot) {
      const project = canonicalizeProjectName(workspaceRoot, "muse");
      for (const r of records) {
        if (r.project === "muse") {
          r.project = project;
          r.cwd = workspaceRoot;
        }
      }
    }

    return records;
  }
}
