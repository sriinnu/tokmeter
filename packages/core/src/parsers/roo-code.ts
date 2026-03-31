/**
 * @tokmeter/core — Roo Code session parser.
 *
 * Reads from VS Code globalStorage task directories.
 */

import type { TokenRecord, SessionParser } from "../types.js";
import {
  expandHome,
  createRecord,
  findFiles,
} from "./utils.js";
import { readFile } from "node:fs/promises";

interface RooUiMessage {
  type?: string;
  say?: string;
  ts?: string;
  text?: string;
}

interface RooApiReqStarted {
  cost?: number;
  tokensIn?: number;
  tokensOut?: number;
  cacheReads?: number;
  cacheWrites?: number;
  apiProtocol?: string;
  model?: string;
  modelName?: string;
}

export class RooCodeParser implements SessionParser {
  readonly providerId = "roo-code" as const;

  private readonly paths = [
    "~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
    "~/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
  ];

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    for (const basePath of this.paths) {
      const dir = expandHome(basePath, homeDir);
      const jsonFiles = await findFiles(dir, (f) => f === "ui_messages.json", 3);

      for (const file of jsonFiles) {
        try {
          const raw = await readFile(file, "utf-8");
          const messages: RooUiMessage[] = JSON.parse(raw);

          for (const msg of messages) {
            if (msg.type !== "say" || msg.say !== "api_req_started" || !msg.text) continue;

            let data: RooApiReqStarted;
            try {
              data = JSON.parse(msg.text) as RooApiReqStarted;
            } catch {
              continue;
            }

            records.push(
              createRecord({
                timestamp: msg.ts ? new Date(msg.ts).getTime() : Date.now(),
                provider: "roo-code",
                model: data.model || data.modelName || "unknown",
                project: "roo-code",
                sourceFile: file,
                inputTokens: data.tokensIn ?? 0,
                outputTokens: data.tokensOut ?? 0,
                cacheReadTokens: data.cacheReads ?? 0,
                cacheWriteTokens: data.cacheWrites ?? 0,
                cost: data.cost ?? 0,
              }),
            );
          }
        } catch {
          // skip
        }
      }
    }
    return records;
  }
}
