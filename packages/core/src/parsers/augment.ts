/**
 * @sriinnu/tokmeter-core — Augment (Auggie CLI) session parser.
 *
 * Reads from ~/.augment/sessions/*.json
 *
 * Each file is one session: `{ sessionId, created, modified, chatHistory[] }`.
 * A turn is `chatHistory[].exchange` with a `request_id` and `response_nodes[]`.
 * The final response node carries `token_usage` (Anthropic-style — input_tokens
 * already excludes the cached read, so no subtraction):
 *
 *   token_usage = {
 *     input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens
 *   }
 *
 * Placeholder nodes carry no `token_usage` (null), only the real response node
 * does, so we emit one record per node that actually has usage and dedup on the
 * node `id`. Augment does not record the model id in the session, so model
 * falls back to "unknown" (tokens surface; pricing pends a model). Project
 * comes from the first `repository_root` / `folder_root` found in the file.
 */

import { canonicalizeProjectName } from "../project-name.js";
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonFile } from "./utils.js";

interface AugmentTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface AugmentNode {
  id?: string;
  token_usage?: AugmentTokenUsage;
  timestamp_ms?: number;
}

interface AugmentExchange {
  request_id?: string;
  response_nodes?: AugmentNode[];
}

interface AugmentSession {
  sessionId?: string;
  created?: number;
  modified?: number;
  chatHistory?: { exchange?: AugmentExchange }[];
}

/** Walk any object graph for the first repository_root / folder_root string. */
function findRepoRoot(obj: unknown): string | undefined {
  const stack = [obj];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    const rec = cur as Record<string, unknown>;
    const root = rec.repository_root ?? rec.folder_root;
    if (typeof root === "string" && root) return root;
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return undefined;
}

export class AugmentParser implements SessionParser {
  readonly providerId = "augment" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const sessionsDir = expandHome("~/.augment/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".json"), 2);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const session = await readJsonFile<AugmentSession>(file);
      if (!session?.chatHistory) continue;

      const repoRoot = findRepoRoot(session);
      const project = repoRoot ? canonicalizeProjectName(repoRoot, "augment") : "augment";
      const sessionTs = typeof session.created === "number" ? session.created : undefined;
      const seen = new Set<string>();

      for (let e = 0; e < session.chatHistory.length; e++) {
        const entry = session.chatHistory[e];
        const nodes = entry.exchange?.response_nodes;
        if (!nodes) continue;
        const reqId = entry.exchange?.request_id ?? "";

        // One record per EXCHANGE (request_id), not per node. Per AGENTS.md,
        // usage is not uniform across a turn's nodes — a turn opens with
        // placeholder nodes (null token_usage) and the real node carries the
        // counts, so we keep the MAX per bucket across the exchange's
        // usage-bearing nodes rather than summing (summing would double-count a
        // node that repeats a running total). In observed data exactly one node
        // per exchange carries usage, so max == that node.
        let anyUsage = false;
        let maxIn = 0;
        let maxOut = 0;
        let maxCacheRead = 0;
        let maxCacheWrite = 0;
        let bestTotal = 0;
        let bestNode: AugmentNode | undefined;
        for (const node of nodes) {
          const u = node.token_usage;
          if (!u) continue;
          const nIn = u.input_tokens ?? 0;
          const nOut = u.output_tokens ?? 0;
          const nCr = u.cache_read_input_tokens ?? 0;
          const nCw = u.cache_creation_input_tokens ?? 0;
          const total = nIn + nOut + nCr + nCw;
          if (total <= 0) continue;
          anyUsage = true;
          maxIn = Math.max(maxIn, nIn);
          maxOut = Math.max(maxOut, nOut);
          maxCacheRead = Math.max(maxCacheRead, nCr);
          maxCacheWrite = Math.max(maxCacheWrite, nCw);
          if (total >= bestTotal) {
            bestTotal = total;
            bestNode = node;
          }
        }
        if (!anyUsage) continue;

        const id = reqId || bestNode?.id || `${file}#${e}`;
        if (seen.has(id)) continue;
        seen.add(id);

        const ts =
          typeof bestNode?.timestamp_ms === "number" && Number.isFinite(bestNode.timestamp_ms)
            ? bestNode.timestamp_ms
            : (sessionTs ?? Date.now());

        records.push(
          createRecord({
            timestamp: ts,
            provider: "augment",
            model: "unknown",
            project,
            cwd: repoRoot,
            sourceFile: file,
            apiCallId: id,
            inputTokens: maxIn,
            outputTokens: maxOut,
            cacheReadTokens: maxCacheRead,
            cacheWriteTokens: maxCacheWrite,
          })
        );
      }
    }

    return records;
  }
}
