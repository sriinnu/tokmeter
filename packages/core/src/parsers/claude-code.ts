import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  extractProjectFromPath,
  filterFilesByMtime,
  findFiles,
  getCachedRecords,
  readJsonlFile,
  readJsonlFileFromOffset,
  setCachedRecords,
} from "./utils.js";

interface ClaudeContentBlock {
  type?: string;
  /** Tool name on `type: "tool_use"` blocks (Bash, Read, Edit, …). */
  name?: string;
}

interface ClaudeMessage {
  type: string;
  subtype?: string;
  /** API request id — shared by every line written for one response. */
  requestId?: string;
  message?: {
    /** API message id — shared by every line written for one response. */
    id?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
      /** TTL split of cache_creation_input_tokens; 1h writes bill at a higher rate. */
      cache_creation?: {
        ephemeral_5m_input_tokens?: number;
        ephemeral_1h_input_tokens?: number;
      };
    };
    /** Content blocks — assistant turns mix `thinking`, `text`, `tool_use`. */
    content?: ClaudeContentBlock[];
  };
  timestamp?: string;
  costUSD?: number;
  /**
   * Present on `{ type: "system", subtype: "compact_boundary" }` events that
   * Claude Code writes when a session is auto- or manually-compacted. We use
   * its presence as the canonical signal: the assistant message immediately
   * preceding the boundary is the summarization API call — tag it so the
   * bar can break out "% of spend going to compaction".
   */
  compactMetadata?: {
    trigger?: "auto" | "manual";
    success?: boolean;
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
    error?: string;
  };
}

function compactionTelemetry(metadata: ClaudeMessage["compactMetadata"] = {}) {
  const preTokens = metadata.preTokens;
  const postTokens = metadata.postTokens;
  const compressionRatio =
    typeof preTokens === "number" && preTokens > 0 && typeof postTokens === "number"
      ? Math.max(0, Math.min(1, 1 - postTokens / preTokens))
      : undefined;

  return {
    source: "tool_jsonl" as const,
    trigger: metadata.trigger,
    success: metadata.success,
    durationMs: metadata.durationMs,
    preTokens,
    postTokens,
    compressionRatio,
    error: metadata.error,
  };
}

/**
 * Claude Code slugs a cwd into its projects dir by replacing `/` with `-`.
 * `/Users/me/src/app` → `~/.claude/projects/-Users-me-src-app/`. We best-effort
 * reverse it for display hints. Literal dashes in original dir names get
 * folded into slashes — acceptable since this is purely an identification hint.
 */
function decodeClaudeSlugDir(filePath: string): string | undefined {
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  const projectsIdx = parts.indexOf("projects");
  const slug = projectsIdx >= 0 ? parts[projectsIdx + 1] : undefined;
  if (!slug) return undefined;
  // Slug always starts with a leading dash representing the root `/`.
  return slug.startsWith("-") ? `/${slug.slice(1).replace(/-/g, "/")}` : undefined;
}

export class ClaudeCodeParser implements SessionParser {
  readonly providerId = "claude-code" as const;

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const projectsDir = expandHome("~/.claude/projects", homeDir);
    // Depth 5: main sessions live at `<slug>/<sessionId>.jsonl` (depth 2),
    // subagent runs at `<slug>/<sessionId>/subagents/agent-*.jsonl` (depth 4).
    // Previous depth 3 silently missed every subagent file — those costs
    // vanished from totals. Bumping picks them up + the parser tags them via
    // `isSubagent` so the aggregator can break out "subagent share."
    let files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 5);
    // Today-only scans skip files untouched since the watermark — a warm
    // daemon refresh reads only today's active sessions, not the whole vault.
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }
    const records: TokenRecord[] = [];

    for (const file of files) {
      const cacheResult = await getCachedRecords(file);

      // Exact cache hit — file unchanged, skip entirely
      if (cacheResult.hit) {
        records.push(...cacheResult.records);
        continue;
      }

      const project = extractProjectFromPath(file);
      const cwd = decodeClaudeSlugDir(file);
      const isSubagent = file.includes("/subagents/");

      // Append mode: only parse new bytes from where we left off. Read faults
      // fail soft but surface via onWarning so a rebuild knows it's partial.
      const readFault = (error: unknown) =>
        opts?.onWarning?.(
          `failed read of ${file}: ${error instanceof Error ? error.message : error}`
        );
      const lines =
        cacheResult.appendOffset > 0
          ? await readJsonlFileFromOffset<ClaudeMessage>(file, cacheResult.appendOffset, readFault)
          : await readJsonlFile<ClaudeMessage>(file, readFault);

      const newRecords: TokenRecord[] = [];
      // Dedup: one record per API response. Claude Code writes an assistant
      // turn as one line per content block (thinking, text, each tool_use),
      // every line carrying the same message.id, requestId and usage — a turn
      // with 8 parallel tool calls is 8 lines for ONE charge. Keying on
      // timestamp (each line has its own) counted such a turn 8×. Seed from
      // the cached tail so a turn whose lines straddle two append scans is
      // still folded into one record.
      let lastUsageKey = cacheResult.cachedRecords.at(-1)?.apiCallId ?? "";
      // Most recent assistant record, including cached tail records during
      // append-only scans. A compact_boundary can arrive after we cached the
      // assistant summarization call, so the boundary must be allowed to tag
      // the cached tail record instead of only records parsed in this chunk.
      //
      // Important: if the cached tail is ALREADY tagged as compaction, leave
      // it alone — re-tagging would overwrite its existing compaction
      // telemetry with whichever boundary we see first in this chunk, which
      // is the WRONG boundary (the one that fired AFTER an assistant turn we
      // haven't parsed yet). The freshly-parsed assistant record will become
      // the new lastAssistantRecord below and the right boundary will tag it.
      const cachedTail = cacheResult.cachedRecords[cacheResult.cachedRecords.length - 1] ?? null;
      let lastAssistantRecord: TokenRecord | null =
        cachedTail && cachedTail.kind === "compaction" ? null : cachedTail;
      for (const msg of lines) {
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          if (lastAssistantRecord) {
            lastAssistantRecord.kind = "compaction";
            lastAssistantRecord.compaction = compactionTelemetry(msg.compactMetadata);
            // Don't re-tag if a second boundary follows without an assistant
            // turn in between (defensive — shouldn't happen in practice).
            lastAssistantRecord = null;
          }
          continue;
        }
        if (msg.type !== "assistant" || !msg.message?.usage) continue;

        const usage = msg.message.usage;
        // Tool names on this assistant turn. Multiple tool_use blocks in one
        // message are common (parallel tool calls) — we keep them all and
        // split cost evenly downstream in the aggregator. Skip nil/empty so
        // we don't bloat records that were pure text answers.
        const toolCalls: string[] = [];
        for (const block of msg.message.content ?? []) {
          if (block.type === "tool_use" && block.name) {
            toolCalls.push(block.name);
          }
        }

        // message.id alone identifies the API response (a retry gets a new
        // id; the corpus has no id shared by two requestIds). Some lines omit
        // requestId, so keying on the pair would split one call in two.
        const apiCallId = msg.message.id || undefined;
        // Older transcripts without ids fall back to timestamp + usage, which
        // still folds the consecutive duplicate lines those versions wrote.
        const usageKey =
          apiCallId ??
          (msg.timestamp
            ? `${msg.timestamp}:${usage.input_tokens ?? 0}:${usage.output_tokens ?? 0}:${usage.cache_read_input_tokens ?? 0}`
            : "");
        const write1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
        if (usageKey && usageKey === lastUsageKey) {
          // Same API response, later content block. Main transcripts repeat
          // the identical usage on every line, but subagent transcripts write
          // the first line from message_start with placeholder usage
          // (output_tokens 2..17) and only the last line carries the real
          // counts — keeping the first line lost ~95% of subagent output.
          // Usage is cumulative for the response, so the max per bucket is
          // the true value. A record whose usage grew must be re-priced.
          if (lastAssistantRecord) {
            const rec = lastAssistantRecord;
            const grow = (cur: number, next: number) => (next > cur ? next : cur);
            const before = `${rec.inputTokens}|${rec.outputTokens}|${rec.cacheReadTokens}|${rec.cacheWriteTokens}|${rec.cacheWrite1hTokens ?? 0}`;
            rec.inputTokens = grow(rec.inputTokens, usage.input_tokens ?? 0);
            rec.outputTokens = grow(rec.outputTokens, usage.output_tokens ?? 0);
            rec.cacheReadTokens = grow(rec.cacheReadTokens, usage.cache_read_input_tokens ?? 0);
            rec.cacheWriteTokens = grow(
              rec.cacheWriteTokens,
              usage.cache_creation_input_tokens ?? 0
            );
            if (write1h > (rec.cacheWrite1hTokens ?? 0)) rec.cacheWrite1hTokens = write1h;
            const after = `${rec.inputTokens}|${rec.outputTokens}|${rec.cacheReadTokens}|${rec.cacheWriteTokens}|${rec.cacheWrite1hTokens ?? 0}`;
            if (after !== before && rec.usage?.cost !== "direct") rec.cost = 0;
            if (toolCalls.length > 0) {
              rec.toolCalls = [...(rec.toolCalls ?? []), ...toolCalls];
            }
          }
          continue;
        }
        if (usageKey) lastUsageKey = usageKey;

        const record = createRecord({
          timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
          provider: "claude-code",
          model: msg.message.model || "unknown",
          project,
          cwd,
          sourceFile: file,
          inputTokens: usage.input_tokens ?? 0,
          outputTokens: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
          ...(write1h > 0 ? { cacheWrite1hTokens: write1h } : {}),
          cost: msg.costUSD ?? 0,
          usage: typeof msg.costUSD === "number" ? { cost: "direct" } : { cost: "calculated" },
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          isSubagent: isSubagent ? true : undefined,
          apiCallId,
        });
        newRecords.push(record);
        lastAssistantRecord = record;
      }

      // Merge cached records with newly parsed ones. Pass the stat hint that
      // getCachedRecords already took so the cache entry's mtime/size reflect
      // the bytes we actually parsed — a concurrent writer appending between
      // parse and cache-set would otherwise cause the next exact-match check
      // to skip the new bytes (silent token loss).
      const allFileRecords = [...cacheResult.cachedRecords, ...newRecords];
      await setCachedRecords(file, allFileRecords, cacheResult.statHint);
      records.push(...allFileRecords);
    }
    return records;
  }
}
