/**
 * @sriinnu/tokmeter-core — Task directory cleaner.
 *
 * For VS Code extension providers (roo-code, kilo) where sourceFile is
 * ui_messages.json inside a task directory. Deletes the entire task dir.
 */
import type { CleanupResult, CleanupTarget, ProviderId, SessionCleaner } from "../types.js";
export declare class TaskDirCleaner implements SessionCleaner {
  readonly providerId: ProviderId;
  constructor(providerId: ProviderId);
  resolveTargets(sourceFiles: string[], _homeDir: string): Promise<CleanupTarget[]>;
  executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult>;
}
/** Factory: create task-dir cleaners for VS Code extension providers. */
export declare function createTaskDirCleaners(): TaskDirCleaner[];
