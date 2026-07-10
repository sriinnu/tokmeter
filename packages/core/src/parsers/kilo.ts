/**
 * @sriinnu/tokmeter-core — Kilo (VS Code extension) session parser.
 *
 * Same shape as Roo Code — reads ui_messages.json from VS Code globalStorage.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  findFiles,
  getConfiguredProviderPaths,
  vscodeFamilyUserDirs,
} from "./utils.js";

interface KiloUiMessage {
  type?: string;
  say?: string;
  ts?: string;
  text?: string;
}

export class KiloParser implements SessionParser {
  readonly providerId = "kilo" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];
    const userDirs = [
      ...vscodeFamilyUserDirs(["Code", "Code - Insiders"], homeDir),
      expandHome("~/.vscode-server/data/User", homeDir),
      ...getConfiguredProviderPaths("kilo", homeDir).map((p) => expandHome(p, homeDir)),
    ];

    for (const userDir of userDirs) {
      const dir = join(userDir, "globalStorage/kilocode.kilo-code/tasks");
      const jsonFiles = await findFiles(dir, (f) => f === "ui_messages.json", 3);

      for (const file of jsonFiles) {
        try {
          const raw = await readFile(file, "utf-8");
          const messages: KiloUiMessage[] = JSON.parse(raw);

          for (const msg of messages) {
            if (msg.type !== "say" || msg.say !== "api_req_started" || !msg.text) continue;

            let data: {
              cost?: number;
              tokensIn?: number;
              tokensOut?: number;
              cacheReads?: number;
              cacheWrites?: number;
              apiProtocol?: string;
              model?: string;
              modelName?: string;
            };
            try {
              data = JSON.parse(msg.text);
            } catch {
              continue;
            }
            const hasCost = typeof data.cost === "number";

            records.push(
              createRecord({
                timestamp: msg.ts ? new Date(msg.ts).getTime() : Date.now(),
                provider: "kilo",
                model: data.model || data.modelName || "unknown",
                project: "kilo",
                sourceFile: file,
                inputTokens: data.tokensIn ?? 0,
                outputTokens: data.tokensOut ?? 0,
                cacheReadTokens: data.cacheReads ?? 0,
                cacheWriteTokens: data.cacheWrites ?? 0,
                cost: data.cost ?? 0,
                usage: hasCost ? { cost: "direct" } : { cost: "calculated" },
              })
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
