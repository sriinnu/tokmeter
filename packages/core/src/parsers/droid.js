/**
 * @sriinnu/tokmeter-core — Droid (Factory Droid) session parser.
 *
 * Reads from ~/.factory/sessions/
 */
import { createRecord, expandHome, findFiles, readJsonlFile } from "./utils.js";
export class DroidParser {
  providerId = "droid";
  async scan(homeDir) {
    const sessionsDir = expandHome("~/.factory/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f.endsWith(".jsonl"), 2);
    const records = [];
    for (const file of files) {
      const lines = await readJsonlFile(file);
      for (const msg of lines) {
        if (msg.role !== "assistant" || !msg.usage) continue;
        records.push(
          createRecord({
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
            provider: "droid",
            model: msg.model || "unknown",
            project: "droid",
            sourceFile: file,
            inputTokens: msg.usage.input_tokens ?? 0,
            outputTokens: msg.usage.output_tokens ?? 0,
            cacheReadTokens: msg.usage.cache_read_tokens ?? 0,
            cacheWriteTokens: msg.usage.cache_write_tokens ?? 0,
          })
        );
      }
    }
    return records;
  }
}
