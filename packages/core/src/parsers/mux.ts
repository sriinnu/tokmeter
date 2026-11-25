/**
 * @sriinnu/tokmeter-core — Mux session parser.
 *
 * Reads from ~/.mux/sessions/{WORKSPACE_ID}/session-usage.json
 */

import { stat } from "node:fs/promises";
import { localDateKey } from "../date-utils.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { type Buckets, dayDelta, updateBaselines } from "./cumulative-baselines.js";
import { createRecord, expandHome, filterFilesByMtime, findFiles, readJsonFile } from "./utils.js";

interface MuxSessionUsage {
  timestamp?: string;
  byModel?: Record<
    string,
    {
      input?: number;
      cached?: number;
      cacheCreate?: number;
      output?: number;
      reasoning?: number;
    }
  >;
}

export class MuxParser implements SessionParser {
  readonly providerId = "mux" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.mux/sessions", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [sessionsDir] = this.sessionRoots(homeDir);
    let files = await findFiles(sessionsDir, (f) => f === "session-usage.json", 2);
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }
    const observations: Array<{
      file: string;
      ts: number;
      createdOn?: string;
      modelKey: string;
      model: string;
      tokens: Buckets;
    }> = [];

    for (const file of files) {
      try {
        const usage = await readJsonFile<MuxSessionUsage>(file);
        if (!usage?.byModel) continue;

        // The file is rewritten with the session's running total, so its
        // timestamp (or mtime) is "last touched", and its birth time is when
        // the session started.
        let ts = usage.timestamp ? new Date(usage.timestamp).getTime() : Number.NaN;
        let createdOn: string | undefined;
        try {
          const s = await stat(file);
          if (!Number.isFinite(ts)) ts = s.mtimeMs;
          if (s.birthtimeMs > 0) createdOn = localDateKey(s.birthtimeMs);
        } catch (error) {
          if (!Number.isFinite(ts)) throw error;
          // A parsed usage timestamp is authoritative; birth time is optional.
        }
        if (!Number.isFinite(ts)) continue;

        for (const [modelKey, tokens] of Object.entries(usage.byModel)) {
          // Model names use "provider:model" format -- strip provider prefix
          const model = modelKey.includes(":") ? modelKey.split(":").slice(1).join(":") : modelKey;
          observations.push({
            file,
            ts,
            createdOn,
            modelKey,
            model,
            tokens: {
              inputTokens: tokens.input ?? 0,
              outputTokens: tokens.output ?? 0,
              cacheReadTokens: tokens.cached ?? 0,
              cacheWriteTokens: tokens.cacheCreate ?? 0,
              reasoningTokens: tokens.reasoning ?? 0,
            },
          });
        }
      } catch (error) {
        opts?.onWarning?.(
          `mux: failed read of ${file}: ${error instanceof Error ? error.message : error}`,
          { file }
        );
      }
    }

    if (observations.length === 0) return [];
    return updateBaselines(homeDir, (baselines, changed) => {
      const records: TokenRecord[] = [];
      for (const obs of observations) {
        // Only the growth since the day began is that day's usage; the whole
        // running total counted the session's history again every day it
        // was touched. See cumulative-baselines.ts.
        const delta = dayDelta(
          baselines,
          `mux:${obs.file}#${obs.modelKey}`,
          localDateKey(obs.ts),
          obs.tokens,
          obs.createdOn,
          changed
        );
        if (!delta) continue;

        records.push(
          createRecord({
            timestamp: obs.ts,
            provider: "mux",
            model: obs.model,
            project: "mux",
            sourceFile: obs.file,
            ...delta,
          })
        );
      }
      return records;
    });
  }
}
