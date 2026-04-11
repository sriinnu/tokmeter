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
export class ClaudeCodeParser {
  providerId = "claude-code";
  async scan(homeDir) {
    const projectsDir = expandHome("~/.claude/projects", homeDir);
    const files = await findFiles(projectsDir, (f) => f.endsWith(".jsonl"), 3);
    const records = [];
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
          ? await readJsonlFileFromOffset(file, cacheResult.appendOffset)
          : await readJsonlFile(file);
      const newRecords = [];
      // Dedup: using both usage values and a stable per-message discriminator so
      // distinct consecutive assistant messages with identical usage are kept.
      let lastUsageKey = "";
      for (const msg of lines) {
        if (msg.type !== "assistant" || !msg.message?.usage) continue;
        const usage = msg.message.usage;
        const messageDiscriminator = msg.timestamp ?? "";
        const usageKey = messageDiscriminator
          ? `${messageDiscriminator}:${usage.input_tokens ?? 0}:${usage.output_tokens ?? 0}:${usage.cache_read_input_tokens ?? 0}`
          : "";
        if (usageKey && usageKey === lastUsageKey) continue;
        if (usageKey) lastUsageKey = usageKey;
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
