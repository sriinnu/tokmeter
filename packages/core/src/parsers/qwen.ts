/**
 * @sriinnu/tokmeter-core — Qwen CLI session parser.
 *
 * Reads from ~/.qwen/projects/{PROJECT_PATH}/chats/{CHAT_ID}.jsonl
 */

import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  extractProjectFromPath,
  filterFilesByMtime,
  findFiles,
  readJsonlFile,
} from "./utils.js";

interface QwenMessage {
  type?: string;
  model?: string;
  timestamp?: string;
  sessionId?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
    cachedContentTokenCount?: number;
  };
}

export class QwenParser implements SessionParser {
  readonly providerId = "qwen" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.qwen/projects", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const [projectsDir] = this.sessionRoots(homeDir);
    let files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 3);
    if (opts?.modifiedSinceMs !== undefined) {
      files = await filterFilesByMtime(files, opts.modifiedSinceMs);
    }
    const records: TokenRecord[] = [];

    for (const file of files) {
      const project = extractProjectFromPath(file);
      const lines = await readJsonlFile<QwenMessage>(file, (err) =>
        opts?.onWarning?.(
          `qwen: failed read of ${file}: ${err instanceof Error ? err.message : err}`,
          { file }
        )
      );

      for (const msg of lines) {
        if (!msg.usageMetadata) continue;

        // Google's UsageMetadata reports promptTokenCount as TOTAL prompt tokens
        // (including cached). Subtract cached so inputTokens = uncached only,
        // matching Anthropic semantics. Otherwise the cost calculator double-
        // charges cached tokens (once at full input rate, once at cache rate).
        const totalPrompt = msg.usageMetadata.promptTokenCount ?? 0;
        const cached = msg.usageMetadata.cachedContentTokenCount ?? 0;
        const inputTokens = Math.max(0, totalPrompt - cached);

        records.push(
          createRecord({
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : undefined,
            provider: "qwen",
            model: msg.model || "qwen",
            project,
            sourceFile: file,
            inputTokens,
            outputTokens: msg.usageMetadata.candidatesTokenCount ?? 0,
            reasoningTokens: msg.usageMetadata.thoughtsTokenCount ?? 0,
            cacheReadTokens: cached,
          })
        );
      }
    }
    return records;
  }
}
