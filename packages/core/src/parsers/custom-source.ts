/**
 * @sriinnu/tokmeter-core — Custom source parser.
 *
 * The "point tokmeter at a path and it gets picked up" hatch. Reads the
 * `customSources` entries from ~/.tokmeter/config.json and scans each one for
 * session files written in the canonical usage-line format — one JSON object
 * per API response:
 *
 *   {
 *     "ts": 1791019404212,          // ms since epoch, or an ISO 8601 string
 *     "id": "resp-abc123",          // provider's per-response id (dedup key)
 *     "model": "claude-sonnet-4.6", // resolved model id, for pricing
 *     "project": "/abs/path/cwd",   // or "cwd"; canonicalized to a project
 *     "input_tokens": 1234,         // UNCACHED input (Anthropic-style)
 *     "output_tokens": 567,
 *     "cache_read_tokens": 890,
 *     "cache_write_tokens": 0,
 *     "reasoning_tokens": 0,
 *     "cost": 0.0123               // optional; USD floor if we can't price
 *   }
 *
 * camelCase keys (inputTokens, cacheReadTokens, …) are accepted too, and the
 * token buckets may instead be nested under a `usage` object:
 *
 *   { "ts": …, "id": …, "model": "claude-sonnet-4.6",
 *     "usage": { "input_tokens": 1234, "output_tokens": 567, … } }
 *
 * This is the contract an agent with no native telemetry (Ribhu, Grok,
 * anything you build) emits to show up in tokmeter without shipping a bespoke
 * parser.
 *
 * Ribhu (the agent formerly called Takumi) is the motivating case: it routes
 * through Chitragupta, so the model varies per response. `provider` stays the
 * AGENT ("ribhu") — never the routed vendor — and each line's `model` carries
 * whatever the router actually dispatched to, so kosha prices it. One session
 * can mix models turn-to-turn; each line is independent. If only the router
 * name ("chitragupta") is known, tokens still land and cost pends until kosha
 * knows that name.
 *
 * Records are tagged with the source's `provider` when it is a custom-eligible
 * id (ribhu, grok, custom); anything else falls back to "custom".
 */

import { type CustomSource, loadConfig } from "../config-service.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { ProviderId, ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

/** Provider ids a custom source is allowed to claim. */
const CUSTOM_ELIGIBLE: ReadonlySet<ProviderId> = new Set<ProviderId>(["ribhu", "grok", "custom"]);

interface CanonicalUsageLine {
  ts?: number | string;
  id?: string;
  model?: string;
  project?: string;
  cwd?: string;
  cost?: number;
  /**
   * Token buckets may sit at the top level OR nested under `usage` — most
   * agents (and Takumi, which routes through Chitragupta and writes whatever
   * model the router picked) nest them. Both snake_case and camelCase keys are
   * read, from whichever level carries them.
   */
  usage?: UsageBuckets;
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_read_tokens?: number;
  cacheReadTokens?: number;
  cache_write_tokens?: number;
  cacheWriteTokens?: number;
  reasoning_tokens?: number;
  reasoningTokens?: number;
}

interface UsageBuckets {
  input_tokens?: number;
  inputTokens?: number;
  output_tokens?: number;
  outputTokens?: number;
  cache_read_tokens?: number;
  cacheReadTokens?: number;
  cache_write_tokens?: number;
  cacheWriteTokens?: number;
  reasoning_tokens?: number;
  reasoningTokens?: number;
}

function resolveProvider(source: CustomSource): ProviderId {
  const p = source.provider as ProviderId | undefined;
  return p && CUSTOM_ELIGIBLE.has(p) ? p : "custom";
}

function toMillis(ts: number | string | undefined): number {
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

export class CustomSourceParser implements SessionParser {
  // A single parser serves every registered source; individual records carry
  // their own (custom-eligible) provider id.
  readonly providerId = "custom" as const;

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
    const sources = loadConfig(homeDir).customSources.filter(
      (s) => s.enabled !== false && s.format === "tokmeter-usage-jsonl"
    );

    for (const source of sources) {
      const provider = resolveProvider(source);
      const root = expandHome(source.path, homeDir);
      const files = await findFiles(root, (f) => f.endsWith(".jsonl") || f.endsWith(".json"), 6);

      for (const file of files) {
        const lines = await readJsonlFile<CanonicalUsageLine>(file);
        const records = this.parseLines(lines, file, provider);
        if (records.length > 0) await onFile(records);
      }
    }
  }

  private parseLines(
    lines: CanonicalUsageLine[],
    file: string,
    provider: ProviderId
  ): TokenRecord[] {
    const records: TokenRecord[] = [];
    const seen = new Set<string>();
    let ordinal = 0;

    for (const line of lines) {
      // Buckets come from the nested `usage` object when present, else the top
      // level — so both `{usage:{input_tokens}}` and `{input_tokens}` work.
      const u: UsageBuckets = line.usage ?? line;
      const input = u.input_tokens ?? u.inputTokens;
      const output = u.output_tokens ?? u.outputTokens;
      const cacheRead = u.cache_read_tokens ?? u.cacheReadTokens ?? 0;
      const cacheWrite = u.cache_write_tokens ?? u.cacheWriteTokens ?? 0;
      const reasoning = u.reasoning_tokens ?? u.reasoningTokens ?? 0;

      // A line with no token fields at all is not a usage record — skip it so
      // a mixed log (prompts + usage) only contributes real spend.
      if (input === undefined && output === undefined && !cacheRead && !cacheWrite && !reasoning) {
        continue;
      }

      const id = line.id ?? `${file}#${ordinal}`;
      if (seen.has(id)) continue;
      seen.add(id);
      ordinal++;

      const where = line.project ?? line.cwd;
      const rec = createRecord({
        timestamp: toMillis(line.ts),
        provider,
        model: line.model || "unknown",
        project: where ? canonicalizeProjectName(where, provider) : provider,
        cwd: line.cwd,
        sourceFile: file,
        apiCallId: line.id ? id : undefined,
        inputTokens: input ?? 0,
        outputTokens: output ?? 0,
        cacheReadTokens: cacheRead,
        cacheWriteTokens: cacheWrite,
        reasoningTokens: reasoning,
      });
      if (typeof line.cost === "number" && line.cost > 0) rec.cost = line.cost;
      records.push(rec);
    }

    return records;
  }
}
