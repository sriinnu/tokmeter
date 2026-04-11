/**
 * @sriinnu/tokmeter-core — Simple file cleaner.
 *
 * Base cleaner for providers whose session data is a single file per session.
 * Covers: codex, gemini, amp, droid, pi, kimi, qwen, mux, cursor.
 */
import { lstat, rm } from "node:fs/promises";
export class SimpleFileCleaner {
  providerId;
  constructor(providerId) {
    this.providerId = providerId;
  }
  async resolveTargets(sourceFiles, _homeDir) {
    const targets = [];
    for (const file of sourceFiles) {
      let sizeBytes = 0;
      try {
        const s = await lstat(file);
        sizeBytes = s.size;
      } catch {
        // File may already be gone — skip
        continue;
      }
      targets.push({
        path: file,
        type: "file",
        sizeBytes,
        provider: this.providerId,
        description: "session file",
      });
    }
    return targets;
  }
  async executeCleanup(targets) {
    let deletedCount = 0;
    let bytesFreed = 0;
    const errors = [];
    for (const t of targets) {
      try {
        await rm(t.path, { force: true });
        deletedCount++;
        bytesFreed += t.sizeBytes;
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
}
/** Factory: create simple file cleaners for all straightforward providers. */
export function createSimpleFileCleaners() {
  const providers = ["codex", "gemini", "amp", "droid", "pi", "kimi", "qwen", "mux", "cursor"];
  return providers.map((id) => new SimpleFileCleaner(id));
}
