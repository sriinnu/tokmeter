/**
 * @tokmeter/core — Claude Code session parser.
 *
 * Reads from ~/.claude/projects/{projectPath}/*.jsonl
 * Format: JSONL with assistant messages containing usage data.
 */

import { join } from "node:path";
import type { TokenRecord, SessionParser } from "../types.js";
import {
  expandHome,
  findFiles,
  readJsonlFile,
  createRecord,
  extractProjectFromPath,
} from "./utils.js";

interface ClaudeMessage {
  type: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  timestamp?: string;
  costUSD?: number;
}

export class ClaudeCodeParser implements SessionParser {
  readonly providerId = "claude-code" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const projectsDir = expandHome("~/.claude/projects", homeDir);
    const files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 3);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const project = extractProjectFromPath(file);
      const lines = await readJsonlFile<ClaudeMessage>(file);

      for (const msg of lines) {
        if (msg.type !== "assistant" || !msg.message?.usage) continue;

        const usage = msg.message.usage;
        records.push(
          createRecord({
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
            provider: "claude-code",
            model: msg.message.model || "unknown",
            project,
            sourceFile: file,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            cost: msg.costUSD ?? 0,
          }),
        );
      }
    }
    return records;
  }
}
