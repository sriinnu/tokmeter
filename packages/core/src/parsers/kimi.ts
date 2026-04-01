/**
 * @tokmeter/core — Kimi CLI session parser.
 *
 * Reads from ~/.kimi/sessions/{GROUP_ID}/{SESSION_UUID}/wire.jsonl
 */

import type { TokenRecord, SessionParser } from "../types.js";
import {
  expandHome,
  findFiles,
  readJsonlFile,
  createRecord,
} from "./utils.js";

interface KimiStatusUpdate {
  timestamp?: number;
  message?: {
    type?: string;
    payload?: {
      token_usage?: {
        input_other?: number;
        output?: number;
        input_cache_read?: number;
        input_cache_creation?: number;
      };
      message_id?: string;
    };
  };
}

export class KimiParser implements SessionParser {
  readonly providerId = "kimi" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const sessionsDir = expandHome("~/.kimi/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f === "wire.jsonl", 4);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const lines = await readJsonlFile<KimiStatusUpdate>(file);
      for (const line of lines) {
        const payload = line.message?.payload;
        if (!payload?.token_usage) continue;

        records.push(
          createRecord({
            // Kimi timestamps are in seconds — convert to ms. Guard against already-ms values.
            timestamp: line.timestamp
              ? (line.timestamp > 1e12 ? line.timestamp : line.timestamp * 1000)
              : Date.now(),
            provider: "kimi",
            model: "kimi",
            project: "kimi",
            sourceFile: file,
            inputTokens: payload.token_usage.input_other ?? 0,
            outputTokens: payload.token_usage.output ?? 0,
            cacheReadTokens: payload.token_usage.input_cache_read ?? 0,
            cacheWriteTokens: payload.token_usage.input_cache_creation ?? 0,
          }),
        );
      }
    }
    return records;
  }
}
