/**
 * @tokmeter/core — Amp (AmpCode) session parser.
 *
 * Reads from ~/.local/share/amp/threads/
 */

import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

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

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const threadsDir = expandHome("~/.local/share/amp/threads", homeDir);
    const files = await findFiles(threadsDir, (f) => f.endsWith(".jsonl"), 2);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const lines = await readJsonlFile<AmpMessage>(file);
      for (const msg of lines) {
        if (msg.role !== "assistant" || !msg.usage) continue;

        const ts =
          typeof msg.timestamp === "number"
            ? msg.timestamp
            : msg.timestamp
              ? new Date(msg.timestamp).getTime()
              : Date.now();

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
