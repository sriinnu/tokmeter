import type { SessionParser, TokenRecord } from "../types.js";
import {
  createRecord,
  expandHome,
  extractProjectFromPath,
  findFiles,
  getCachedRecords,
  readJsonlFile,
  readJsonlFileFromOffset,
  setCachedRecords,
} from "./utils.js";

interface ClaudeMessage {
  type: string;
  message?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  timestamp?: string;
  costUSD?: number;
}

export class ClaudeCodeParser implements SessionParser {
  readonly providerId = "claude-code" as const;

  async scan(homeDir: string): Promise<TokenRecord[]> {
    const projectsDir = expandHome("~/.claude/projects", homeDir);
    const files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 3);
    const records: TokenRecord[] = [];

    for (const file of files) {
      const cacheResult = await getCachedRecords(file);

      // Exact cache hit — file unchanged, skip entirely
      if (cacheResult.hit) {
        records.push(...cacheResult.records);
        continue;
      }

      const project = extractProjectFromPath(file);

      // Append mode: only parse new bytes from where we left off
      const lines =
        cacheResult.appendOffset > 0
          ? await readJsonlFileFromOffset<ClaudeMessage>(file, cacheResult.appendOffset)
          : await readJsonlFile<ClaudeMessage>(file);

      const newRecords: TokenRecord[] = [];
      // Dedup: Claude Code streaming events can emit identical usage blocks
      // for the same assistant message. Track the last usage key per file
      // and skip consecutive duplicates.
      let lastUsageKey = "";
      for (const msg of lines) {
        if (msg.type !== "assistant" || !msg.message?.usage) continue;

        const usage = msg.message.usage;
        const usageKey = `${usage.input_tokens ?? 0}:${usage.output_tokens ?? 0}:${usage.cache_read_input_tokens ?? 0}`;
        if (usageKey === lastUsageKey) continue;
        lastUsageKey = usageKey;

        newRecords.push(
          createRecord({
            timestamp: msg.timestamp ? new Date(msg.timestamp).getTime() : Date.now(),
            provider: "claude-code",
            model: msg.message.model || "unknown",
            project,
            sourceFile: file,
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            cacheReadTokens: usage.cache_read_input_tokens ?? 0,
            cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            cost: msg.costUSD ?? 0,
          })
        );
      }

      // Merge cached records with newly parsed ones
      const allFileRecords = [...cacheResult.cachedRecords, ...newRecords];
      await setCachedRecords(file, allFileRecords);
      records.push(...allFileRecords);
    }
    return records;
  }
}
