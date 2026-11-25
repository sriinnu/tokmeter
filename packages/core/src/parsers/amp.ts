/**
 * @sriinnu/tokmeter-core — Amp (AmpCode) session parser.
 *
 * Reads from ~/.local/share/amp/threads/
 */

import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, filterFilesByMtime, findFiles, readJsonlFile } from "./utils.js";

interface AmpMessage {
  role?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  timestamp?: string | number;
}

export class AmpParser implements SessionParser {
  readonly providerId = "amp" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.local/share/amp/threads", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [threadsDir] = this.sessionRoots(homeDir);
    let files = await findFiles(threadsDir, (f) => f.endsWith(".jsonl"), 2);
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }
    const records: TokenRecord[] = [];

    for (const file of files) {
      const lines = await readJsonlFile<AmpMessage>(file, (err) =>
        opts?.onWarning?.(
          `amp: failed read of ${file}: ${err instanceof Error ? err.message : err}`,
          { file }
        )
      );
      for (const msg of lines) {
        if (msg.role !== "assistant" || !msg.usage) continue;

        const ts =
          typeof msg.timestamp === "number"
            ? msg.timestamp
            : msg.timestamp
              ? new Date(msg.timestamp).getTime()
              : undefined;

        records.push(
          createRecord({
            timestamp: ts,
            provider: "amp",
            model: msg.model || "unknown",
            project: "amp",
            sourceFile: file,
            inputTokens: msg.usage.input ?? 0,
            outputTokens: msg.usage.output ?? 0,
            cacheReadTokens: msg.usage.cacheRead ?? 0,
            cacheWriteTokens: msg.usage.cacheWrite ?? 0,
          })
        );
      }
    }
    return records;
  }
}
