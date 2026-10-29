import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  extractProjectFromPath,
  filterFilesByMtime,
  findFiles,
  getCachedRecords,
  type JsonlVisitResult,
  MAX_JSONL_RECORDS,
  type OversizedLine,
  setCachedRecords,
  visitJsonlLines,
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

/** Newest record timestamp in a file's cached records (append-only ⇒ the last). */
function lastTimestamp(records: TokenRecord[]): number | undefined {
  const last = records.at(-1);
  return last ? last.timestamp : undefined;
}

/** The JSON object starting at `start` (a `{`), or null if it doesn't close. */
function balancedObject(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

/**
 * Best-effort recovery of an assistant line too long to buffer (a huge tool
 * input). Claude Code writes `message.model` and `message.id` first and
 * `usage`, `type` and `timestamp` last, so the kept head and tail hold every
 * field a record needs. Returns null when any of them is missing — the caller
 * then reports the line as a possible gap instead of guessing.
 */
/**
 * The top-level `type` of a line too long to parse. Claude Code writes it near
 * the end, after `message`, so the LAST role-valued `type` in the tail is the
 * line's own (a pasted transcript inside a tool result sits before it); a
 * writer that puts `type` first has it as the first one in the head.
 */
function oversizedRole(line: OversizedLine): string | undefined {
  const role = /"type":"(assistant|user|system|summary)"/g;
  const inTail = [...line.tail.matchAll(role)].at(-1)?.[1];
  return inTail ?? /"type":"(assistant|user|system|summary)"/.exec(line.head)?.[1];
}

function recoverOversizedAssistant(line: OversizedLine): ClaudeMessage | null {
  const { head, tail } = line;
  if (oversizedRole(line) !== "assistant") return null;
  const usageIn = (text: string, fromEnd: boolean) => {
    const at = fromEnd ? text.lastIndexOf('"usage":{') : text.indexOf('"usage":{');
    return at < 0 ? null : balancedObject(text, at + '"usage":'.length);
  };
  // Claude Code's own key order puts usage after the content (tail); other
  // writers may put it first (head). Prefer the tail, fall back to the head.
  const usageJson = usageIn(tail, true) ?? usageIn(head, false);
  const id =
    /"id":"(msg_[A-Za-z0-9_-]+)"/.exec(head)?.[1] ?? /"id":"(msg_[A-Za-z0-9_-]+)"/.exec(tail)?.[1];
  const model =
    /"model":"([^"]{1,200})"/.exec(head)?.[1] ?? /"model":"([^"]{1,200})"/.exec(tail)?.[1];
  const stamps = [...tail.matchAll(/"timestamp":"([^"]{1,64})"/g)];
  const timestamp = stamps.at(-1)?.[1] ?? /"timestamp":"([^"]{1,64})"/.exec(head)?.[1];
  if (!usageJson || !id || !timestamp) return null;
  try {
    const usage = JSON.parse(usageJson) as NonNullable<ClaudeMessage["message"]>["usage"];
    return { type: "assistant", timestamp, message: { id, model, usage, content: [] } };
  } catch {
    return null;
  }
}

/**
 * One record per API response across a session's whole family of files.
 * `message.id` is the API's own response id, unique by construction, so the
 * same id in two files is the same charge. Claude Code's fork subagents open
 * their transcript with a `fork-context-ref` line followed by a copy of the
 * parent's last assistant message — same id, same usage, a new timestamp — and
 * counting both double-billed one parent turn per fork (47 forks, 14.4M
 * cache-read tokens over a month). Keyed on the id rather than on the
 * fork-context-ref shape, so a future version that copies more context, or
 * any other replay, folds the same way. The earliest copy is kept (the
 * original response, in the day it happened); the max per bucket is taken in
 * case a copy was written from a later line of the same response.
 */
export function dedupAcrossFiles(records: TokenRecord[]): TokenRecord[] {
  const byId = new Map<string, number>();
  const out: TokenRecord[] = [];
  for (const r of records) {
    if (!r.apiCallId) {
      out.push(r);
      continue;
    }
    const at = byId.get(r.apiCallId);
    if (at === undefined) {
      byId.set(r.apiCallId, out.length);
      out.push(r);
      continue;
    }
    const kept = out[at]!;
    const first = r.timestamp < kept.timestamp ? r : kept;
    const other = first === r ? kept : r;
    const grown =
      other.inputTokens > first.inputTokens ||
      other.outputTokens > first.outputTokens ||
      other.cacheReadTokens > first.cacheReadTokens ||
      other.cacheWriteTokens > first.cacheWriteTokens ||
      (other.cacheWrite1hTokens ?? 0) > (first.cacheWrite1hTokens ?? 0);
    if (!grown) {
      out[at] = first;
      continue;
    }
    // Never mutate a cached record: copy, take the max, re-price.
    const merged: TokenRecord = {
      ...first,
      inputTokens: Math.max(first.inputTokens, other.inputTokens),
      outputTokens: Math.max(first.outputTokens, other.outputTokens),
      cacheReadTokens: Math.max(first.cacheReadTokens, other.cacheReadTokens),
      cacheWriteTokens: Math.max(first.cacheWriteTokens, other.cacheWriteTokens),
    };
    const write1h = Math.max(first.cacheWrite1hTokens ?? 0, other.cacheWrite1hTokens ?? 0);
    if (write1h > 0) merged.cacheWrite1hTokens = Math.min(write1h, merged.cacheWriteTokens);
    if (merged.usage?.cost !== "direct") merged.cost = 0;
    out[at] = merged;
  }
  return out;
}

export class ClaudeCodeParser implements SessionParser {
  readonly providerId = "claude-code" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.claude/projects", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [projectsDir] = this.sessionRoots(homeDir);
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
      const handle = (msg: ClaudeMessage): void => {
        if (msg.type === "system" && msg.subtype === "compact_boundary") {
          if (lastAssistantRecord) {
            lastAssistantRecord.kind = "compaction";
            lastAssistantRecord.compaction = compactionTelemetry(msg.compactMetadata);
            // Don't re-tag if a second boundary follows without an assistant
            // turn in between (defensive — shouldn't happen in practice).
            lastAssistantRecord = null;
          }
          return;
        }
        if (msg.type !== "assistant" || !msg.message?.usage) return;

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
        // The 1h-TTL share is a subset of cache_creation_input_tokens. Claude
        // Code has written 1h = 2050 beside a total of 0 (2026-09-16); keep
        // the subset invariant here so no bucket downstream can exceed it.
        const write1h = Math.min(
          usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
          usage.cache_creation_input_tokens ?? 0
        );
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
          return;
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
      };

      // Stream only the bytes past the cached offset, one line at a time:
      // memory is one line, never the file, so a session of any size keeps
      // counting (a whole-file 128 MiB refusal froze sessions past that size).
      // Only lines that can carry usage or a compaction boundary are parsed.
      let readFailed = false;
      let malformedLines = 0;
      let malformedUsageLines = 0;
      let unrecoveredOversized = 0;
      const onLine = (line: string) => {
        if (!line.includes('"assistant"') && !line.includes("compact_boundary")) return;
        let msg: ClaudeMessage;
        try {
          msg = JSON.parse(line) as ClaudeMessage;
        } catch {
          malformedLines++;
          if (line.includes('"usage"')) malformedUsageLines++;
          return;
        }
        handle(msg);
      };
      const onOversized = (line: OversizedLine) => {
        const recovered = recoverOversizedAssistant(line);
        if (recovered) handle(recovered);
        else if (oversizedRole(line) === "assistant") unrecoveredOversized++;
      };
      let visit: JsonlVisitResult | null = null;
      try {
        visit = await visitJsonlLines(file, cacheResult.appendOffset, onLine, { onOversized });
      } catch (error) {
        readFailed = true;
        opts?.onWarning?.(
          `failed read of ${file}: ${error instanceof Error ? error.message : error}`,
          { file, readThroughMs: lastTimestamp(cacheResult.cachedRecords) }
        );
      }
      if (visit?.inFlightTail) {
        // Not a failure (the cache resumes at the line's start), but the line
        // may be a record from before midnight: the rollover must not seal
        // the day without it. Everything unread is newer than what was read,
        // so a seal of a day before the last record read is not held.
        opts?.onWarning?.(`a line in ${file} is still being written`, {
          file,
          readThroughMs: lastTimestamp([...cacheResult.cachedRecords, ...newRecords]),
        });
      }
      if (visit && visit.oversizedLines > 0) {
        const lost = unrecoveredOversized;
        const message = `skipped ${visit.oversizedLines} oversized line(s) in ${file}${lost > 0 ? ` (${lost} assistant line(s) without recoverable usage)` : ""}`;
        // An assistant line we could not recover may hide usage: that is a
        // real gap, reported like a read fault. Anything else (tool output,
        // pasted files) carries no tokens — a notice, not a partial scan.
        if (lost > 0) opts?.onWarning?.(message, { file });
        else opts?.onNotice?.(message);
      }
      if (malformedUsageLines > 0) {
        opts?.onWarning?.(
          `skipped ${malformedLines} malformed line(s) in ${file}, ${malformedUsageLines} of them carrying usage`,
          { file }
        );
      } else if (malformedLines > 0) {
        opts?.onNotice?.(`skipped ${malformedLines} malformed line(s) in ${file}`);
      }

      // Merge cached records with newly parsed ones. Pass the stat hint that
      // getCachedRecords already took so the cache entry's mtime/size reflect
      // the bytes we actually parsed — a concurrent writer appending between
      // parse and cache-set would otherwise cause the next exact-match check
      // to skip the new bytes (silent token loss).
      const allFileRecords = [...cacheResult.cachedRecords, ...newRecords];
      const cacheWouldExceedLimit = allFileRecords.length > MAX_JSONL_RECORDS;
      if (cacheWouldExceedLimit) {
        readFailed = true;
        opts?.onWarning?.(
          `failed read of ${file}: cached record limit (${MAX_JSONL_RECORDS}) exceeded`,
          { file }
        );
      }
      // Never seal a read failure as an empty/partial successful cache entry.
      // The previous good cache remains usable and the next scan retries.
      if (!readFailed && visit) {
        await setCachedRecords(file, allFileRecords, {
          mtimeMs: visit.snapshot.mtimeMs,
          sizeBytes: visit.consumedThroughBytes,
        });
      }
      records.push(...(cacheWouldExceedLimit ? cacheResult.cachedRecords : allFileRecords));
    }
    return dedupAcrossFiles(records);
  }
}
