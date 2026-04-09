/**
 * @sriinnu/tokmeter-core — Gemini CLI session parser.
 *
 * Reads from ~/.gemini/tmp/{id}/chats/{file}.json
 */

import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonFile } from "./utils.js";

interface GeminiMessage {
  type?: string;
  model?: string;
  timestamp?: string;
  tokens?: {
    input?: number;
    output?: number;
    cached?: number;
    thoughts?: number;
  };
}

interface GeminiSession {
  sessionId?: string;
  timestamp?: string;
  messages?: GeminiMessage[];
}

export class GeminiParser implements SessionParser {
  readonly providerId = "gemini" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const geminiDir = expandHome("~/.gemini/tmp", homeDir);
    const files = await findFiles(geminiDir, (f) => f.endsWith(".json"), 4);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const session = await readJsonFile<GeminiSession>(file);
      if (!session?.messages) continue;

      // Use session-level timestamp as fallback for messages without timestamps
      const sessionTs = session.timestamp ? new Date(session.timestamp).getTime() : undefined;

      for (const msg of session.messages) {
        if (msg.type !== "gemini" || !msg.tokens) continue;

        // Prefer per-message timestamp, fall back to session timestamp, then Date.now()
        const ts = msg.timestamp ? new Date(msg.timestamp).getTime() : (sessionTs ?? Date.now());

        // Gemini CLI mirrors Google's API: tokens.input is the TOTAL prompt
        // (including cached). Subtract the cached portion so inputTokens =
        // uncached only, matching Anthropic semantics and preventing double-
        // charge in the cost calculator.
        const totalInput = msg.tokens.input ?? 0;
        const cached = msg.tokens.cached ?? 0;
        const inputTokens = Math.max(0, totalInput - cached);

        records.push(
          createRecord({
            timestamp: ts,
            provider: "gemini",
            model: msg.model || "gemini-pro",
            project: "gemini",
            sourceFile: file,
            inputTokens,
            outputTokens: msg.tokens.output ?? 0,
            cacheReadTokens: cached,
            reasoningTokens: msg.tokens.thoughts ?? 0,
          })
        );
      }
    }
    return records;
  }
}
