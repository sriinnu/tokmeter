/**
 * @tokmeter/core — Codex CLI session parser.
 *
 * Reads from ~/.codex/sessions/*.jsonl
 * Format: Event-based with token_count events.
 */

import type { TokenRecord, SessionParser } from "../types.js";
import {
  expandHome,
  findFiles,
  readJsonlFile,
  createRecord,
} from "./utils.js";

interface CodexEvent {
  type?: string;
  payload?: {
    type?: string;
    info?: {
      model?: string;
      last_token_usage?: {
        input_tokens?: number;
        output_tokens?: number;
      };
    };
  };
  timestamp?: string;
}

export class CodexParser implements SessionParser {
  readonly providerId = "codex" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const sessionsDir = expandHome("~/.codex/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 1);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const lines = await readJsonlFile<CodexEvent>(file);
      for (const evt of lines) {
        if (evt.type !== "event_msg") continue;
        const payload = evt.payload;
        if (!payload || payload.type !== "token_count") continue;
        const info = payload.info;
        if (!info?.last_token_usage) continue;

        records.push(
          createRecord({
            timestamp: evt.timestamp ? new Date(evt.timestamp).getTime() : Date.now(),
            provider: "codex",
            model: info.model || "gpt-4o",
            project: "codex",
            sourceFile: file,
            inputTokens: info.last_token_usage.input_tokens ?? 0,
            outputTokens: info.last_token_usage.output_tokens ?? 0,
          }),
        );
      }
    }
    return records;
  }
}
