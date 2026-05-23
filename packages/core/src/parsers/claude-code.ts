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
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
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

      // Append mode: only parse new bytes from where we left off
      const lines =
        cacheResult.appendOffset > 0
          ? await readJsonlFileFromOffset<ClaudeMessage>(file, cacheResult.appendOffset)
          : await readJsonlFile<ClaudeMessage>(file);

      const newRecords: TokenRecord[] = [];
      // Dedup: using both usage values and a stable per-message discriminator so
      // distinct consecutive assistant messages with identical usage are kept.
      let lastUsageKey = "";
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
      const cachedTail =
        cacheResult.cachedRecords[cacheResult.cachedRecords.length - 1] ?? null;
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
        const messageDiscriminator = msg.timestamp ?? "";
        const usageKey = messageDiscriminator
          ? `${messageDiscriminator}:${usage.input_tokens ?? 0}:${usage.output_tokens ?? 0}:${usage.cache_read_input_tokens ?? 0}`
          : "";
        if (usageKey && usageKey === lastUsageKey) continue;
        if (usageKey) lastUsageKey = usageKey;

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
          cost: msg.costUSD ?? 0,
          usage: typeof msg.costUSD === "number" ? { cost: "direct" } : { cost: "calculated" },
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
          isSubagent: isSubagent ? true : undefined,
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
