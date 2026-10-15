/**
 * @sriinnu/tokmeter-core — Ribhu Code usage-log parser.
 *
 * Reads from ~/.ribhu/usage/{START_MS}-{PID}.jsonl — one file per Ribhu
 * process, one JSON object per model response:
 *
 *   {"id": "ribhu-1792013194717-62211-0", "ts": 1792013194717,
 *    "project": "/abs/cwd", "model": "deepseek-v4-pro", "provider": "deepseek",
 *    "input_tokens": 52, "output_tokens": 3, "cache_read_tokens": 5504,
 *    "cache_write_tokens": 0, "cost": null}
 *
 * Ribhu routes through the Chitragupta kernel, so `model` varies per response
 * and is whatever the kernel actually dispatched to. `provider` (the routed
 * vendor) is optional and informational; the record's provider stays the
 * AGENT ("ribhu"). When the route was unknown Ribhu writes the router's own
 * name ("chitragupta" / "chitragupta-kernel-router"): those tokens still
 * count, attributed to "unknown" rather than an invented model.
 *
 * `input_tokens` is uncached input (Anthropic-style), per Ribhu's writer.
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

interface RibhuUsageLine {
  id?: string;
  ts?: number;
  project?: string;
  model?: string;
  provider?: string;
  input_tokens?: number;
  output_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  cost?: number | null;
}

/** Router names Ribhu writes when the routed model was not reported. */
const UNROUTED_MODELS: ReadonlySet<string> = new Set(["chitragupta", "chitragupta-kernel-router"]);

/** The model to attribute a line to: the routed model, or "unknown". */
export function ribhuModel(model: string | undefined): string {
  if (!model || UNROUTED_MODELS.has(model)) return "unknown";
  return model;
}

export class RibhuParser implements SessionParser {
  readonly providerId = "ribhu" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.ribhu/usage", homeDir)];
  }

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const [usageDir] = this.sessionRoots(homeDir);
    const files = await findFiles(usageDir, (f) => f.endsWith(".jsonl"), 1);
    const records: TokenRecord[] = [];
    const seen = new Set<string>();

    for (const file of files) {
      const lines = await readJsonlFile<RibhuUsageLine>(file);
      for (const line of lines) {
        if (line.input_tokens === undefined && line.output_tokens === undefined) continue;

        // Ids embed the file stem and a per-process sequence, so they are
        // unique across files; a repeated id is a duplicated line.
        if (line.id) {
          if (seen.has(line.id)) continue;
          seen.add(line.id);
        }

        const hasCost = typeof line.cost === "number" && Number.isFinite(line.cost);
        records.push(
          createRecord({
            timestamp: typeof line.ts === "number" ? line.ts : Date.now(),
            provider: "ribhu",
            model: ribhuModel(line.model),
            project: line.project ? canonicalizeProjectName(line.project, "ribhu") : "ribhu",
            cwd: line.project,
            sourceFile: file,
            apiCallId: line.id,
            inputTokens: line.input_tokens ?? 0,
            outputTokens: line.output_tokens ?? 0,
            cacheReadTokens: line.cache_read_tokens ?? 0,
            cacheWriteTokens: line.cache_write_tokens ?? 0,
            // A daemon-reported cost is a fact; null means "price it".
            cost: hasCost ? (line.cost as number) : 0,
            usage: hasCost ? { cost: "direct" } : { cost: "calculated" },
          })
        );
      }
    }
    return records;
  }
}
