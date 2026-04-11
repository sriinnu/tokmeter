/**
 * @sriinnu/tokmeter-core — Roo Code session parser.
 *
 * Reads from VS Code globalStorage task directories.
 */
import { readFile } from "node:fs/promises";
import { createRecord, expandHome, findFiles } from "./utils.js";
export class RooCodeParser {
  providerId = "roo-code";
  paths = [
    "~/.config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
    "~/.vscode-server/data/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
  ];
  async scan(homeDir) {
    const records = [];
    for (const basePath of this.paths) {
      const dir = expandHome(basePath, homeDir);
      const jsonFiles = await findFiles(dir, (f) => f === "ui_messages.json", 3);
      for (const file of jsonFiles) {
        try {
          const raw = await readFile(file, "utf-8");
          const messages = JSON.parse(raw);
          for (const msg of messages) {
            if (msg.type !== "say" || msg.say !== "api_req_started" || !msg.text) continue;
            let data;
            try {
              data = JSON.parse(msg.text);
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
