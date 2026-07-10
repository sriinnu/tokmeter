/**
 * @sriinnu/tokmeter-core — persisted per-thread checkpoints for the Codex
 * SQLite fallback (codex-desktop.ts).
 *
 * state_5.sqlite's `threads.tokens_used` is a CUMULATIVE lifetime total per
 * thread, not a discrete per-event delta like the CLI's JSONL token_count
 * events. Emitting the raw total on every scan would recount a thread's
 * entire history every time the daemon polls — this file tracks the last
 * tokens_used value we've already counted per thread so codex-desktop.ts can
 * emit only the genuinely new delta, exactly like antigravity-live.ts's
 * snapshot-delta pattern.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodexSqliteCheckpoints {
  [threadId: string]: { lastTokensUsed: number; lastSeenAt: number };
}

function checkpointPath(homeDir: string): string {
  return join(homeDir, ".cache", "tokmeter", "codex-sqlite-checkpoints.json");
}

/** Reads the checkpoint map, or {} if it's never been written / is corrupt. */
export function readCheckpoints(homeDir: string): CodexSqliteCheckpoints {
  try {
    const raw = readFileSync(checkpointPath(homeDir), "utf-8");
    return JSON.parse(raw) as CodexSqliteCheckpoints;
  } catch {
    return {};
  }
}

/** Atomic write (temp + rename) so a crash mid-write never corrupts the file. */
export function writeCheckpoints(checkpoints: CodexSqliteCheckpoints, homeDir: string): void {
  const path = checkpointPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(checkpoints));
  renameSync(tmp, path);
}
