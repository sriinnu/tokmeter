/**
 * @sriinnu/tokmeter-core — Pi session parser.
 *
 * Reads from ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
 */
import { canonicalizeProjectName } from "../project-name.js";
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";
export class PiParser {
  providerId = "pi";
  async scan(homeDir) {
    const sessionsDir = expandHome("~/.pi/agent/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 3);
    const records = [];
    for (const file of files) {
      const lines = await readJsonlFile(file);
      let project = "pi";
      for (const line of lines) {
        if (line.type === "session") {
          const header = line;
          project = header.cwd ? canonicalizeProjectName(header.cwd, "pi") : "pi";
          continue;
        }
        if (line.type !== "message") continue;
        const msg = line;
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
