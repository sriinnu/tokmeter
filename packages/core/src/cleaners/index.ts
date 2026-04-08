/**
 * @sriinnu/tokmeter-core — Cleaner registry.
 *
 * Mirrors packages/core/src/parsers/index.ts but for cleanup operations.
 */

import type { ProviderId, SessionCleaner } from "../types.js";
import { ClaudeCodeCleaner } from "./claude-code.js";
import { OpenclawCleaner } from "./openclaw.js";
import { createSimpleFileCleaners } from "./simple-file-cleaner.js";
import { createSqliteCleaners } from "./sqlite-cleaner.js";
import { createTaskDirCleaners } from "./task-dir-cleaner.js";

/** All available cleaners, one per provider (except synthetic which has no files). */
export const ALL_CLEANERS: SessionCleaner[] = [
  new ClaudeCodeCleaner(),
  ...createSimpleFileCleaners(),
  ...createTaskDirCleaners(),
  ...createSqliteCleaners(),
  new OpenclawCleaner(),
];

/** Get a cleaner for a specific provider. */
export function getCleaner(id: ProviderId): SessionCleaner | undefined {
  return ALL_CLEANERS.find((c) => c.providerId === id);
}

/** Get cleaners for specific providers, or all if no filter. */
export function getCleaners(ids?: ProviderId[]): SessionCleaner[] {
  if (!ids || ids.length === 0) return ALL_CLEANERS;
  return ALL_CLEANERS.filter((c) => ids.includes(c.providerId));
}
