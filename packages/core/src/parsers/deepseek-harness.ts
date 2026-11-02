/**
 * @sriinnu/tokmeter-core — DeepSeek Harness (desktop app) session parser.
 *
 * Reads ~/.dsh/sessions/--<cwd>--/<session-id>/session.v<N>.jsonl.zstd, an
 * append-only event log whose first line is the session header. Each write
 * appends one zstd frame, so a real session is hundreds of frames.
 *
 * Bun's zstd stops after the first frame without an error (247 of 3,648,890
 * bytes on a 550-frame session, measured 2026-11-02) and Node's raises only at
 * the end of a truncated stream. Walking the frames here and inflating them one
 * at a time gives the same bytes on both runtimes, and shows exactly when the
 * last frame is still being written.
 *
 * One `assistant/message` event is one API response. Its `data.usage` is
 * disjoint: totalTokens = input + output + cacheRead + cacheWrite on every
 * response checked, so input does not include cache reads. Output includes
 * reasoning; the log has no separate reasoning count.
 *
 * The harness logs no usage for `session/title-llm-request` and
 * `web/deepseek-search-llm-request`, so those calls can't be counted.
 *
 * A forked session starts with a copy of its parent's events, ending at a
 * `session/end-seed` marked `inherited`. That copy was already charged to the
 * parent, so it's dropped here. Older formats mark the cut differently; for
 * those, dedupAcrossFiles folds any copy that kept its message id.
 */

import { readFile, stat } from "node:fs/promises";
import { basename, dirname } from "node:path";
// Namespace import: zstd is Node 22.15+, and a named import of it fails at
// module load on older Node and takes the whole CLI down.
import * as zlib from "node:zlib";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { dedupAcrossFiles } from "./claude-code.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  getCachedRecords,
  setCachedRecords,
} from "./utils.js";

const SESSION_FILE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/;
const ZSTD_FRAME_MAGIC = 0xfd2fb528;
const MAX_SESSION_BYTES = 512 * 1024 * 1024;

interface HarnessEvent {
  type?: string;
  seq?: number;
  time?: number;
  // Header fields (`type: "session"`).
  id?: string;
  cwd?: string;
  origin?: string;
  data?: {
    inherited?: boolean;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
    };
    message?: {
      id?: string;
      source?: { model?: string; replayState?: { response?: { model?: string } } };
      content?: Array<{ type?: string; name?: string; toolName?: string }>;
    };
  };
}

/**
 * Byte length of the zstd frame at `start`, or null if it isn't all there.
 * Skippable frames count as frames (inflating them yields nothing).
 */
export function zstdFrameLength(buf: Buffer, start: number): number | null {
  if (start + 4 > buf.length) return null;
  const magic = buf.readUInt32LE(start);
  if ((magic & 0xfffffff0) === 0x184d2a50) {
    if (start + 8 > buf.length) return null;
    const end = start + 8 + buf.readUInt32LE(start + 4);
    return end <= buf.length ? end - start : null;
  }
  if (magic !== ZSTD_FRAME_MAGIC || start + 5 > buf.length) return null;
  const descriptor = buf[start + 4]!;
  const fcsFlag = descriptor >> 6;
  const singleSegment = (descriptor >> 5) & 1;
  const hasChecksum = (descriptor >> 2) & 1;
  const dictIdBytes = [0, 1, 2, 4][descriptor & 3]!;
  const fcsBytes = fcsFlag === 0 ? singleSegment : 1 << fcsFlag;
  let at = start + 5 + (singleSegment ? 0 : 1) + dictIdBytes + fcsBytes;
  for (;;) {
    if (at + 3 > buf.length) return null;
    const header = buf[at]! | (buf[at + 1]! << 8) | (buf[at + 2]! << 16);
    const isLast = header & 1;
    const blockType = (header >> 1) & 3;
    const blockSize = header >> 3;
    // An RLE block stores one byte however many it expands to.
    at += 3 + (blockType === 1 ? 1 : blockSize);
    if (isLast) break;
  }
  at += hasChecksum ? 4 : 0;
  return at <= buf.length ? at - start : null;
}

/** Hands `onLine` each complete line of `bytes`; returns the unterminated rest. */
function drainLines(bytes: Buffer, onLine: (line: string) => void): Buffer {
  let start = 0;
  for (;;) {
    const newline = bytes.indexOf(10, start);
    if (newline < 0) return bytes.subarray(start);
    onLine(bytes.toString("utf-8", start, newline));
    start = newline + 1;
  }
}

/**
 * Visits every line of a raw or zstd session file. Returns false when the file
 * ends mid-write (a partial frame or line); everything before that point has
 * still been visited.
 */
function visitSessionLines(file: string, bytes: Buffer, onLine: (line: string) => void): boolean {
  if (!file.endsWith(".zstd")) {
    const rest = drainLines(bytes, onLine);
    if (rest.length > 0) onLine(rest.toString("utf-8"));
    return true;
  }
  let pending: Buffer = Buffer.alloc(0);
  let at = 0;
  let intact = true;
  while (at < bytes.length) {
    const length = zstdFrameLength(bytes, at);
    if (length === null) {
      intact = false;
      break;
    }
    const inflated = zlib.zstdDecompressSync(bytes.subarray(at, at + length));
    pending = drainLines(
      pending.length > 0 ? Buffer.concat([pending, inflated]) : inflated,
      onLine
    );
    at += length;
  }
  if (pending.length > 0) {
    // Every appended batch ends its lines, so a remainder that doesn't parse
    // is a cut-off write; the caller sees it as the malformed last line.
    onLine(pending.toString("utf-8"));
  }
  return intact;
}

/** The highest generation in each session directory: the only one the app reads. */
function currentGenerations(files: string[]): string[] {
  const best = new Map<string, { file: string; generation: number }>();
  for (const file of files) {
    const match = SESSION_FILE.exec(basename(file));
    if (!match) continue;
    const generation = Number(match[1] ?? 0);
    const dir = dirname(file);
    const seen = best.get(dir);
    // Same generation raw and compressed can't both be current; prefer the
    // compressed root the app writes today.
    if (!seen || generation > seen.generation || (generation === seen.generation && match[2])) {
      best.set(dir, { file, generation });
    }
  }
  return [...best.values()].map((entry) => entry.file);
}

export class DeepSeekHarnessParser implements SessionParser {
  readonly providerId = "deepseek-harness" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.dsh/sessions", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [root] = this.sessionRoots(homeDir);
    const found = await findFiles(root!, (f) => SESSION_FILE.test(basename(f)), 4);
    let files = currentGenerations(found);
    if (typeof zlib.zstdDecompressSync !== "function") {
      const skipped = files.filter((f) => f.endsWith(".zstd")).length;
      if (skipped > 0) {
        opts?.onWarning?.(
          `${skipped} DeepSeek Harness sessions skipped: Node ${process.versions.node} has no zstd; Node 22.15+ reads them`
        );
      }
      files = files.filter((f) => !f.endsWith(".zstd"));
    }
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }

    const records: TokenRecord[] = [];
    for (const file of files) {
      const cached = await getCachedRecords(file);
      if (cached.hit) {
        records.push(...cached.records);
        continue;
      }
      // Compressed bytes can't resume from an offset, so a changed file is
      // re-read whole.
      const parsed = await this.parseFile(file, opts);
      records.push(...parsed);
    }
    return dedupAcrossFiles(records);
  }

  private async parseFile(file: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    // Stat before reading: an append during the read then fails the next
    // exact-match cache check instead of being skipped.
    let bytes: Buffer;
    let snapshot: { mtimeMs: number; size: number };
    try {
      snapshot = await stat(file);
      if (snapshot.size > MAX_SESSION_BYTES) {
        opts?.onWarning?.(`failed read of ${file}: larger than ${MAX_SESSION_BYTES} bytes`, {
          file,
        });
        return [];
      }
      bytes = await readFile(file);
    } catch (error) {
      opts?.onWarning?.(
        `failed read of ${file}: ${error instanceof Error ? error.message : error}`,
        { file }
      );
      return [];
    }

    let records: TokenRecord[] = [];
    const seen = new Set<string>();
    let cwd: string | undefined;
    let sessionId: string | undefined;
    let isSubagent = false;
    let lastSeenMs: number | undefined;
    let malformedUsageLines = 0;
    let lastLineMalformed = false;

    const onLine = (line: string): void => {
      lastLineMalformed = false;
      const relevant =
        line.includes('"assistant/message"') ||
        line.includes('"session/end-seed"') ||
        line.includes('"type":"session"');
      if (!relevant) return;
      let event: HarnessEvent;
      try {
        event = JSON.parse(line) as HarnessEvent;
      } catch {
        lastLineMalformed = true;
        if (line.includes('"assistant/message"')) malformedUsageLines++;
        return;
      }
      if (event.type === "session") {
        cwd = event.cwd;
        sessionId = event.id;
        isSubagent = event.origin === "subagent";
      } else if (event.type === "session/end-seed") {
        if (event.data?.inherited === true) {
          records = [];
          seen.clear();
        }
      } else if (event.type === "assistant/message") {
        const usage = event.data?.usage;
        const timestamp = event.time;
        if (!usage || typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
        lastSeenMs = timestamp;
        const message = event.data?.message;
        const apiCallId = message?.id ?? `${sessionId ?? file}:${event.seq ?? timestamp}`;
        if (seen.has(apiCallId)) return;
        seen.add(apiCallId);
        const input = usage.inputTokens ?? 0;
        const output = usage.outputTokens ?? 0;
        const cacheRead = usage.cacheReadTokens ?? 0;
        const cacheWrite = usage.cacheWriteTokens ?? 0;
        if (input + output + cacheRead + cacheWrite <= 0) return;
        const toolCalls = (message?.content ?? [])
          .filter((block) => block.type === "tool-call")
          .map((block) => block.toolName ?? block.name)
          .filter((name): name is string => Boolean(name));
        records.push(
          createRecord({
            timestamp,
            provider: "deepseek-harness",
            model:
              message?.source?.model ?? message?.source?.replayState?.response?.model ?? "unknown",
            project: cwd ? canonicalizeProjectName(cwd, "deepseek-harness") : "deepseek-harness",
            cwd,
            sourceFile: file,
            apiCallId,
            inputTokens: input,
            outputTokens: output,
            cacheReadTokens: cacheRead,
            cacheWriteTokens: cacheWrite,
            toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            isSubagent: isSubagent ? true : undefined,
          })
        );
      }
    };

    let intact = false;
    try {
      intact = visitSessionLines(file, bytes, onLine);
    } catch (error) {
      opts?.onWarning?.(
        `failed read of ${file}: ${error instanceof Error ? error.message : error}`,
        { file, readThroughMs: lastSeenMs }
      );
      return records;
    }
    // A cut-off last line is the same in-flight state as a partial frame. A bad
    // line anywhere earlier will never heal, so it's reported once and cached.
    if (!intact || lastLineMalformed) {
      // Not a failure, but the unread part may hold a record from before
      // midnight, so the rollover must not seal the day without it. Not cached:
      // the next scan reads the finished write.
      opts?.onWarning?.(`a write in ${file} is still in progress`, {
        file,
        readThroughMs: lastSeenMs,
      });
      return records;
    }
    if (malformedUsageLines > 0) {
      opts?.onWarning?.(`skipped ${malformedUsageLines} malformed usage line(s) in ${file}`, {
        file,
      });
    }
    await setCachedRecords(file, records, { mtimeMs: snapshot.mtimeMs, sizeBytes: snapshot.size });
    return records;
  }
}
