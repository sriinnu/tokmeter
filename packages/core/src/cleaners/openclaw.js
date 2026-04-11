/**
 * @sriinnu/tokmeter-core — OpenClaw cleaner.
 *
 * OpenClaw uses an index file (sessions.json) pointing to session JSONL files.
 * Cleanup deletes the session files and updates the index atomically.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
export class OpenclawCleaner {
  providerId = "openclaw";
  async resolveTargets(sourceFiles, _homeDir) {
    const targets = [];
    const indexFiles = new Set();
    for (const file of sourceFiles) {
      // Session JSONL file
      let sizeBytes = 0;
      try {
        const s = await stat(file);
        sizeBytes = s.size;
      } catch {
        continue;
      }
      targets.push({
        path: file,
        type: "file",
        sizeBytes,
        provider: this.providerId,
        description: "session file",
      });
      // Track the sessions.json index in the same directory tree
      const dir = dirname(file);
      const candidateDirs = [dir, dirname(dir)];
      for (const d of candidateDirs) {
        const indexPath = join(d, "sessions.json");
        if (existsSync(indexPath) && !indexFiles.has(indexPath)) {
          indexFiles.add(indexPath);
          targets.push({
            path: indexPath,
            type: "index-entry",
            sizeBytes: 0,
            provider: this.providerId,
            description: "update sessions.json index",
          });
        }
      }
    }
    return targets;
  }
  async executeCleanup(targets) {
    let deletedCount = 0;
    let bytesFreed = 0;
    const errors = [];
    // Collect deleted file paths for index cleanup
    const deletedFiles = new Set();
    // First pass: delete session files
    for (const t of targets) {
      if (t.type !== "file") continue;
      try {
        await rm(t.path, { force: true });
        deletedCount++;
        bytesFreed += t.sizeBytes;
        deletedFiles.add(t.path);
      } catch (err) {
        errors.push({
          target: t.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    // Second pass: update index files
    for (const t of targets) {
      if (t.type !== "index-entry") continue;
      try {
        this.updateIndex(t.path, deletedFiles);
        deletedCount++;
      } catch (err) {
        errors.push({
          target: t.path,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return {
      deletedCount,
      failedCount: errors.length,
      errors,
      bytesFreed,
    };
  }
  updateIndex(indexPath, deletedFiles) {
    if (!existsSync(indexPath)) return;
    const raw = readFileSync(indexPath, "utf-8");
    const index = JSON.parse(raw);
    // Remove entries whose sessionFile was deleted
    for (const [key, entry] of Object.entries(index)) {
      if (entry.sessionFile && deletedFiles.has(entry.sessionFile)) {
        delete index[key];
      }
    }
    // Atomic write
    const tmpPath = `${indexPath}.tmp`;
    writeFileSync(tmpPath, `${JSON.stringify(index, null, 2)}\n`, "utf-8");
    renameSync(tmpPath, indexPath);
  }
}
