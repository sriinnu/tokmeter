/**
 * @sriinnu/tokmeter-core — Amp (AmpCode) session parser.
 *
 * Reads from ~/.local/share/amp/threads/
 */
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";
export class AmpParser {
  providerId = "amp";
  async scan(homeDir) {
    const threadsDir = expandHome("~/.local/share/amp/threads", homeDir);
    const files = await findFiles(threadsDir, (f) => f.endsWith(".jsonl"), 2);
    const records = [];
    for (const file of files) {
      const lines = await readJsonlFile(file);
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
