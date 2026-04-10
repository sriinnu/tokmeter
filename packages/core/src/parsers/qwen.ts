/**
 * @sriinnu/tokmeter-core — Qwen CLI session parser.
 *
 * Reads from ~/.qwen/projects/{PROJECT_PATH}/chats/{CHAT_ID}.jsonl
 */

import type { SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  extractProjectFromPath,
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

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const projectsDir = expandHome("~/.qwen/projects", homeDir);
    const files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 3);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const project = extractProjectFromPath(file);
      const lines = await readJsonlFile<QwenMessage>(file);

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
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
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
