/**
 * @sriinnu/tokmeter-core — Task directory cleaner.
 *
 * For VS Code extension providers (roo-code, kilo) where sourceFile is
 * ui_messages.json inside a task directory. Deletes the entire task dir.
 */

import { rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import type { CleanupResult, CleanupTarget, ProviderId, SessionCleaner } from "../types.js";

export class TaskDirCleaner implements SessionCleaner {
  readonly providerId: ProviderId;

  constructor(providerId: ProviderId) {
    this.providerId = providerId;
  }

  async resolveTargets(sourceFiles: string[], _homeDir: string): Promise<CleanupTarget[]> {
    const targets: CleanupTarget[] = [];
    const seen = new Set<string>();

    for (const file of sourceFiles) {
      // sourceFile = .../tasks/{taskId}/ui_messages.json → delete the task dir
      const taskDir = dirname(file);
      if (seen.has(taskDir)) continue;
      seen.add(taskDir);

      let sizeBytes = 0;
      try {
        // Estimate dir size from the ui_messages.json file itself
        const s = await stat(file);
        sizeBytes = s.size;
      } catch {
        continue;
      }

      targets.push({
        path: taskDir,
        type: "directory",
        sizeBytes,
        provider: this.providerId,
        description: "task directory",
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
        await rm(t.path, { recursive: true, force: true });
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

/** Factory: create task-dir cleaners for VS Code extension providers. */
export function createTaskDirCleaners(): TaskDirCleaner[] {
  return [new TaskDirCleaner("roo-code"), new TaskDirCleaner("kilo")];
}
