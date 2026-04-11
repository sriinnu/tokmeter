/**
 * @sriinnu/tokmeter-core — OpenClaw cleaner.
 *
 * OpenClaw uses an index file (sessions.json) pointing to session JSONL files.
 * Cleanup deletes the session files and updates the index atomically.
 */
import type { CleanupResult, CleanupTarget, SessionCleaner } from "../types.js";
export declare class OpenclawCleaner implements SessionCleaner {
  readonly providerId: "openclaw";
  resolveTargets(sourceFiles: string[], _homeDir: string): Promise<CleanupTarget[]>;
  executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult>;
  private updateIndex;
}
