/**
 * @sriinnu/tokmeter-core — Simple file cleaner.
 *
 * Base cleaner for providers whose session data is a single file per session.
 * Covers: codex, gemini, amp, droid, pi, kimi, qwen, mux, cursor.
 */

import { lstat, rm } from "node:fs/promises";
import type { CleanupResult, CleanupTarget, ProviderId, SessionCleaner } from "../types.js";

export class SimpleFileCleaner implements SessionCleaner {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  async resolveTargets(sourceFiles: string[], _homeDir: string): Promise<CleanupTarget[]> {
    const targets: CleanupTarget[] = [];

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

  async executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult> {
    let deletedCount = 0;
    let bytesFreed = 0;
    const errors: { target: string; error: string }[] = [];

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
export function createSimpleFileCleaners(): SimpleFileCleaner[] {
  const providers: ProviderId[] = [
    "codex",
    "gemini",
    "amp",
    "droid",
    "pi",
    "kimi",
    "qwen",
    "mux",
    "cursor",
  ];
  return providers.map((id) => new SimpleFileCleaner(id));
}
