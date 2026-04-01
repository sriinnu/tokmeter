/**
 * @tokmeter/core — OpenClaw session parser.
 *
 * Reads from ~/.openclaw/agents/{id}/sessions/sessions.json
 * Also scans legacy paths: ~/.clawdbot/, ~/.moltbot/, ~/.moldbot/
 */

import { dirname, isAbsolute, join } from "node:path";
import type { SessionParser, TokenRecord } from "../types.js";
import { createRecord, expandHome, findFiles, readJsonFile, readJsonlFile } from "./utils.js";

interface OpenClawSessionIndex {
  [key: string]: {
    sessionId?: string;
    sessionFile?: string;
  };
}

interface OpenClawMessage {
  type?: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cost?: { total?: number };
    };
    timestamp?: number;
  };
  modelId?: string;
}

export class OpenClawParser implements SessionParser {
  readonly providerId = "openclaw" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const paths = ["~/.openclaw/agents", "~/.clawdbot", "~/.moltbot", "~/.moldbot"];

    for (const basePath of paths) {
      const dir = expandHome(basePath, homeDir);
      const sessionFiles = await findFiles(dir, (f) => f === "sessions.json", 4);

      for (const sf of sessionFiles) {
        const index = await readJsonFile<OpenClawSessionIndex>(sf);
        if (!index) continue;

        const sfDir = dirname(sf);
        for (const entry of Object.values(index)) {
          if (!entry.sessionFile) continue;

          // Resolve sessionFile relative to the sessions.json directory
          const sessionFilePath = isAbsolute(entry.sessionFile)
            ? entry.sessionFile
            : join(sfDir, entry.sessionFile);

          const lines = await readJsonlFile<OpenClawMessage>(sessionFilePath);
          let currentModel = "unknown";

          for (const msg of lines) {
            if (msg.type === "model_change") {
              currentModel = msg.modelId || currentModel;
              continue;
            }
            if (msg.type !== "message" || msg.message?.role !== "assistant") continue;
            if (!msg.message?.usage) continue;

            records.push(
              createRecord({
                timestamp: msg.message.timestamp ?? Date.now(),
                provider: "openclaw",
                model: currentModel,
                project: "openclaw",
                sourceFile: entry.sessionFile,
                inputTokens: msg.message.usage.input ?? 0,
                outputTokens: msg.message.usage.output ?? 0,
                cacheReadTokens: msg.message.usage.cacheRead ?? 0,
                cost: msg.message.usage.cost?.total ?? 0,
              })
            );
          }
        }
      }
    }
    return records;
  }
}
