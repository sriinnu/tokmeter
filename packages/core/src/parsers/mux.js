/**
 * @sriinnu/tokmeter-core — Mux session parser.
 *
 * Reads from ~/.mux/sessions/{WORKSPACE_ID}/session-usage.json
 */
import { stat } from "node:fs/promises";
import { createRecord, expandHome, findFiles, readJsonFile } from "./utils.js";
export class MuxParser {
  providerId = "mux";
  async scan(homeDir) {
    const sessionsDir = expandHome("~/.mux/sessions", homeDir);
    const files = await findFiles(sessionsDir, (f) => f === "session-usage.json", 2);
    const records = [];
    for (const file of files) {
      const usage = await readJsonFile(file);
      if (!usage?.byModel) continue;
      // Use file modification time as timestamp if no explicit timestamp in JSON
      let ts = usage.timestamp ? new Date(usage.timestamp).getTime() : undefined;
      if (!ts) {
        try {
          const s = await stat(file);
          ts = s.mtimeMs;
        } catch {
          ts = undefined;
        }
      }
      for (const [modelKey, tokens] of Object.entries(usage.byModel)) {
        // Model names use "provider:model" format -- strip provider prefix
        const model = modelKey.includes(":") ? modelKey.split(":").slice(1).join(":") : modelKey;
        records.push(
          createRecord({
            timestamp: ts ?? Date.now(),
            provider: "mux",
            model,
            project: "mux",
            sourceFile: file,
            inputTokens: tokens.input ?? 0,
            outputTokens: tokens.output ?? 0,
            cacheReadTokens: tokens.cached ?? 0,
            cacheWriteTokens: tokens.cacheCreate ?? 0,
            reasoningTokens: tokens.reasoning ?? 0,
          })
        );
      }
    }
    return records;
  }
}
