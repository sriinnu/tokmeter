/**
 * @sriinnu/tokmeter-core — OpenClaw session parser.
 *
 * Reads from ~/.openclaw/agents/{id}/sessions/sessions.json
 * Also scans legacy paths: ~/.clawdbot/, ~/.moltbot/, ~/.moldbot/
 */

import { dirname, isAbsolute, join } from "node:path";
import type { SessionParser, TokenRecord } from "../types.js";
import {
  ANY_PATH_SEGMENT,
  createRecord,
  expandHome,
  findFiles,
  readJsonFile,
  readJsonlFile,
} from "./utils.js";

/** OpenClaw's home plus the legacy names it shipped under. */
const OPENCLAW_HOMES = ["~/.openclaw", "~/.clawdbot", "~/.moltbot", "~/.moldbot"];

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

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return ["~/.openclaw/agents", "~/.clawdbot", "~/.moltbot", "~/.moldbot"].map((p) =>
      expandHome(p, homeDir)
    );
  }

  /**
   * Session data lives in `<home>/agents/<agentId>/sessions/` (sessions.json
   * plus the JSONL files it indexes). The legacy scan roots above are whole
   * config directories that also hold settings and credentials, so restore
   * is limited to the per-agent `sessions` folders.
   */
  restoreRoots(homeDir: string): string[] {
    return OPENCLAW_HOMES.map((h) =>
      join(expandHome(h, homeDir), "agents", ANY_PATH_SEGMENT, "sessions")
    );
  }

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    for (const dir of this.sessionRoots(homeDir)) {
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
            const cost = msg.message.usage.cost?.total;
            const hasCost = typeof cost === "number";

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
                cost: hasCost ? cost : 0,
                usage: hasCost ? { cost: "direct" } : { cost: "calculated" },
              })
            );
          }
        }
      }
    }
    return records;
  }
}
