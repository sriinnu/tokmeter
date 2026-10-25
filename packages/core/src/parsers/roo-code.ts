/**
 * @sriinnu/tokmeter-core — Roo Code session parser.
 *
 * Reads from VS Code globalStorage task directories.
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

  /** Paths this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [
      ...vscodeFamilyUserDirs(["Code", "Code - Insiders"], homeDir),
      expandHome("~/.vscode-server/data/User", homeDir),
      ...getConfiguredProviderPaths("roo-code", homeDir).map((p) => expandHome(p, homeDir)),
    ].map((userDir) => join(userDir, "globalStorage/rooveterinaryinc.roo-cline/tasks"));
  }

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const records: TokenRecord[] = [];

    for (const dir of this.sessionRoots(homeDir)) {
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
            } catch (error) {
              throw new Error(
                `Malformed Roo usage payload in ${file}: ${error instanceof Error ? error.message : error}`
              );
            }
            const hasCost = typeof data.cost === "number";

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
                usage: hasCost ? { cost: "direct" } : { cost: "calculated" },
              })
            );
          }
        } catch (error) {
          throw new Error(
            `Unable to read Roo session ${file}: ${error instanceof Error ? error.message : error}`
          );
        }
      }
    }
    return records;
  }
}
