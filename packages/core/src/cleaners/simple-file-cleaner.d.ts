/**
 * @sriinnu/tokmeter-core — Simple file cleaner.
 *
 * Base cleaner for providers whose session data is a single file per session.
 * Covers: codex, gemini, amp, droid, pi, kimi, qwen, mux, cursor.
 */
import type { CleanupResult, CleanupTarget, ProviderId, SessionCleaner } from "../types.js";
export declare class SimpleFileCleaner implements SessionCleaner {
  readonly providerId: ProviderId;
  constructor(providerId: ProviderId);
  resolveTargets(sourceFiles: string[], _homeDir: string): Promise<CleanupTarget[]>;
  executeCleanup(targets: CleanupTarget[]): Promise<CleanupResult>;
}
/** Factory: create simple file cleaners for all straightforward providers. */
export declare function createSimpleFileCleaners(): SimpleFileCleaner[];
