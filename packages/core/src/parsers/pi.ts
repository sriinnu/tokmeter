/**
 * @sriinnu/tokmeter-core — Pi session parser.
 *
 * Reads from ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
 */

import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";

interface PiSessionHeader {
  type: "session";
  id?: string;
  timestamp?: string;
  cwd?: string;
}

interface PiMessage {
  type: "message";
  id?: string;
  timestamp?: string;
  message?: {
    role?: string;
    model?: string;
    provider?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      totalTokens?: number;
    };
  };
}

export class PiParser implements SessionParser {
  readonly providerId = "pi" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const sessionsDir = expandHome("~/.pi/agent/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 3);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const lines = await readJsonlFile<PiSessionHeader | PiMessage>(file);
      let project = "pi";

      for (const line of lines) {
        if (line.type === "session") {
          const header = line as PiSessionHeader;
          project = header.cwd ? header.cwd.split("/").pop() || "pi" : "pi";
          continue;
        }

        if (line.type !== "message") continue;
        const msg = line as PiMessage;
        if (msg.message?.role !== "assistant" || !msg.message?.usage) continue;

        records.push(
          createRecord({
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
            provider: "pi",
            model: msg.message.model || "unknown",
            project,
            sourceFile: file,
            inputTokens: msg.message.usage.input ?? 0,
            outputTokens: msg.message.usage.output ?? 0,
            cacheReadTokens: msg.message.usage.cacheRead ?? 0,
            cacheWriteTokens: msg.message.usage.cacheWrite ?? 0,
          })
        );
      }
    }
    return records;
  }
}
