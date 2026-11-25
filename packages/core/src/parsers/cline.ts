/**
 * @sriinnu/tokmeter-core — Cline (hub / kanban CLI) session parser.
 *
 * Reads from ~/.cline/apps/kanban/sessions/*.jsonl
 *
 * Each line is `{ ts, stream, chunk }` where `chunk` is a JSON-encoded string.
 * Token usage is on the `stream === "chat_usage"` lines:
 *
 *   chunk = {
 *     inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost,
 *     totalInputTokens, totalOutputTokens, totalCost   // running cumulatives
 *   }
 *
 * The non-`total*` fields are this response's own usage, Anthropic-style
 * (inputTokens already excludes the cached read), so no subtraction. One
 * `chat_usage` line == one API response; the file is append-only and each line
 * is written once, so a stable per-line ordinal within the session is the dedup
 * key (there is no provider response id in the log).
 *
 * Cline's kanban log does not carry the model id or the workspace per response,
 * so model falls back to "unknown" (tokens still surface; pricing pends a model)
 * and project falls back to "cline". Cline computes its own `cost`; we keep it
 * only as a floor when tokmeter cannot price the model.
 */

import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  findFiles,
  lastPathSegment,
  readJsonlFile,
} from "./utils.js";

interface ClineLine {
  ts?: number; // milliseconds
  stream?: string;
  chunk?: string;
}

interface ClineUsageChunk {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  cost?: number;
}

export class ClineParser implements SessionParser {
  readonly providerId = "cline" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.cline/apps/kanban/sessions", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const out: TokenRecord[] = [];
    await this.scanStreaming(homeDir, opts, (records) => {
      out.push(...records);
    });
    return out;
  }

  async scanStreaming(
    homeDir: string,
    opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void> {
    const [sessionsDir] = this.sessionRoots(homeDir);
    let files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 2);
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }

    for (const file of files) {
      try {
        const lines = await readJsonlFile<ClineLine>(file, (err) =>
          opts?.onWarning?.(
            `cline: failed read of ${file}: ${err instanceof Error ? err.message : err}`,
            { file }
          )
        );
        const records = this.parseFile(lines, file);
        if (records.length > 0) await onFile(records);
      } catch (error) {
        opts?.onWarning?.(
          `cline: failed read of ${file}: ${error instanceof Error ? error.message : error}`,
          { file }
        );
      }
    }
  }

  private parseFile(lines: ClineLine[], file: string): TokenRecord[] {
    const records: TokenRecord[] = [];
    const sessionId = lastPathSegment(file, "cline").replace(/\.jsonl$/, "");
    let ordinal = 0;

    for (const line of lines) {
      if (line.stream !== "chat_usage" || !line.chunk) continue;

      let chunk: ClineUsageChunk;
      try {
        chunk = JSON.parse(line.chunk) as ClineUsageChunk;
      } catch (error) {
        throw new Error(
          `Malformed Cline usage payload in ${file}: ${error instanceof Error ? error.message : error}`
        );
      }

      const ts = typeof line.ts === "number" && Number.isFinite(line.ts) ? line.ts : undefined;

      const rec = createRecord({
        timestamp: ts,
        provider: "cline",
        model: "unknown",
        project: "cline",
        sourceFile: file,
        apiCallId: `${sessionId}#${ordinal}`,
        inputTokens: chunk.inputTokens ?? 0,
        outputTokens: chunk.outputTokens ?? 0,
        cacheReadTokens: chunk.cacheReadTokens ?? 0,
        cacheWriteTokens: chunk.cacheWriteTokens ?? 0,
      });
      // Cline logs its own API cost, and the model ID isn't recorded here ("unknown").
      // Mark provenance "direct" so repricing never zeroes it on resetCalculatedCosts.
      if (typeof chunk.cost === "number" && Number.isFinite(chunk.cost) && chunk.cost > 0) {
        rec.cost = chunk.cost;
        if (rec.usage) rec.usage.cost = "direct";
      }
      records.push(rec);
      ordinal++;
    }

    return records;
  }
}
