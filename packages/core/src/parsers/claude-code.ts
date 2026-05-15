import type { SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  extractProjectFromPath,
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
    preTokens?: number;
    postTokens?: number;
    durationMs?: number;
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

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const projectsDir = expandHome("~/.claude/projects", homeDir);
    // Depth 5: main sessions live at `<slug>/<sessionId>.jsonl` (depth 2),
    // subagent runs at `<slug>/<sessionId>/subagents/agent-*.jsonl` (depth 4).
    // Previous depth 3 silently missed every subagent file — those costs
    // vanished from totals. Bumping picks them up + the parser tags them via
    // `isSubagent` so the aggregator can break out "subagent share."
    const files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 5);
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
      // Index of the most recent assistant record we've pushed. When a
      // compact_boundary system message arrives, we retroactively flip that
      // record's kind to "compaction" — Claude Code writes the summarization
      // API call as a normal assistant message right before the boundary, so
      // the most-recent record is the right one to tag.
      let lastAssistantIdx = -1;
      for (const msg of lines) {
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          if (lastAssistantIdx >= 0) {
            newRecords[lastAssistantIdx].kind = "compaction";
            // Don't re-tag if a second boundary follows without an assistant
            // turn in between (defensive — shouldn't happen in practice).
            lastAssistantIdx = -1;
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

        newRecords.push(
          createRecord({
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
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            isSubagent: isSubagent ? true : undefined,
          })
        );
        lastAssistantIdx = newRecords.length - 1;
      }

      // Merge cached records with newly parsed ones
      const allFileRecords = [...cacheResult.cachedRecords, ...newRecords];
      await setCachedRecords(file, allFileRecords);
      records.push(...allFileRecords);
    }
    return records;
  }
}
