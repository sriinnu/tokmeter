/**
 * @sriinnu/tokmeter-core — persisted per-thread day-baselines for the Codex
 * SQLite fallback (codex-desktop.ts).
 *
 * state_5.sqlite's `threads.tokens_used` is a CUMULATIVE lifetime total per
 * thread, not a discrete per-event delta like the CLI's JSONL token_count
 * events. This tracks, per thread, tokens_used AS OF THE START OF THE
 * CURRENT LOCAL DAY (`baselineDate`) — NOT "as of the last scan call".
 *
 * That distinction is load-bearing. TokmeterCore's refreshTodayAccumulator()
 * REPLACES its whole "today" state on every call from whatever scan()
 * returns for today — it never folds/merges across ticks (see
 * DailyAccumulator.hydrate(), a full structuredClone replace). A JSONL
 * parser's scan() is naturally idempotent for "today" because re-reading a
 * file re-derives every one of today's events from their own real
 * timestamps every time. A "delta since the last scan() call" design is
 * NOT idempotent — a first attempt at this file did exactly that, and under
 * the daemon's ~12s refresh cadence each tick's tiny window replaced the
 * previous tick's, so only the LAST few seconds of growth ever survived
 * into "today" and everything before it silently vanished.
 *
 * With a stable start-of-day baseline instead, `tokens_used - baselineTokens`
 * is the same value across repeated same-day scans until real growth
 * happens — genuinely idempotent, matching the contract the rest of the
 * system assumes. The baseline only advances when a new local day is
 * detected (once per thread per day), using whatever tokens_used is at that
 * moment as the best available approximation of "start of today" — the same
 * "can say what changed since we started watching, never what happened
 * before" limitation antigravity-live.ts's credit deltas already accept.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface CodexSqliteCheckpoints {
  [threadId: string]: { baselineTokens: number; baselineDate: string };
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

/**
 * Atomic write (temp + rename) so a crash mid-write never corrupts the file.
 * NOT safe against two concurrent scan() calls racing a read-modify-write —
 * relies on this project's singleton-daemon architecture (see the daemon
 * pidfile reaper) to keep that from happening in practice. A stray manual
 * CLI scan racing the daemon's own poll could theoretically emit the same
 * delta twice; low-probability and not guarded against here.
 */
export function writeCheckpoints(checkpoints: CodexSqliteCheckpoints, homeDir: string): void {
  const path = checkpointPath(homeDir);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(checkpoints));
  renameSync(tmp, path);
}
