/**
 * @sriinnu/tokmeter-core — Legacy history-snapshot invalidation shim.
 *
 * The monolithic `history-snapshot.json` was replaced by per-day relay files
 * under `~/.cache/tokmeter/aggregates/*.json` and is no longer read or written.
 * Kept as a slim shim so cleanup/restore callers and the public barrel export
 * still remove any leftover legacy snapshot file without breaking semver.
 */

import { existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_FILE_NAME = "history-snapshot.json";

/** Delete any leftover legacy history-snapshot.json file (best effort). */
export function invalidateHistorySnapshot(homeDir: string): void {
  const filePath = join(homeDir, ".cache", "tokmeter", SNAPSHOT_FILE_NAME);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Non-blocking by design.
  }
}
