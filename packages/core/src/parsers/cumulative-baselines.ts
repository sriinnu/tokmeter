/**
 * @sriinnu/tokmeter-core — Day deltas for sources that only report a running
 * total (Zed's `cumulative_token_usage`, Mux's `session-usage.json`).
 *
 * Those parsers used to emit the thread's whole lifetime total, stamped on its
 * latest update. So every day a long-lived thread was touched counted its
 * entire history again, and a fresh install put months of usage on one day.
 * This keeps, per thread, the running total as of the start of the day it was
 * last touched, and the parser emits only the growth since then.
 *
 * Idempotent across ticks: the baseline moves only when a thread is touched on
 * a later day than its current baseline day, so re-scanning the same day gives
 * the same delta (the contract TokmeterCore's replace-each-tick "today"
 * relies on; see codex-sqlite-checkpoint.ts for the history of getting that
 * wrong). Known approximations, same as codex-desktop's:
 *   - The first time a thread is seen, its history can't be split across the
 *     days it ran, so it counts nothing until it grows. A thread created that
 *     same day is the exception and counts in full.
 *   - Growth between the last observation of a day and that day's end lands on
 *     the next day it's touched.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFile } from "../private-files.js";

export interface Buckets {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

interface Baseline {
  /** The day `base` applies to: the delta emitted is that day's usage. */
  day: string;
  /**
   * Running total at the start of `day` (as last observed before it). Can go
   * negative within a day after a reset; see dayDelta.
   */
  base: Buckets;
  /** Running total at the latest observation. */
  last: Buckets;
}

export type CumulativeBaselines = Record<string, Baseline>;

const BUCKETS: (keyof Buckets)[] = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "reasoningTokens",
];

const ZERO: Buckets = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
};

function baselinePath(homeDir: string): string {
  return join(homeDir, ".cache", "tokmeter", "cumulative-baselines.json");
}

export function readBaselines(homeDir: string): CumulativeBaselines {
  const path = baselinePath(homeDir);
  ensurePrivateDirectory(dirname(path));
  if (!existsSync(path)) return {};
  ensurePrivateFile(path);
  const raw = JSON.parse(readFileSync(path, "utf-8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`Invalid cumulative baseline schema: ${path}`);
  }
  return raw as CumulativeBaselines;
}

/** Atomic (temp + rename). Same single-writer caveat as codex-sqlite-checkpoint.ts. */
export function writeBaselines(baselines: CumulativeBaselines, homeDir: string): void {
  const path = baselinePath(homeDir);
  writePrivateFile(path, JSON.stringify(baselines));
}

/**
 * The usage `current` adds on `day`, or null when there's nothing to emit.
 * Mutates `baselines`; returns whether it changed via `changed`.
 *
 * @param key       stable per-thread id, provider-scoped
 * @param day       local date the thread was last touched
 * @param current   the running total now
 * @param createdOn local date the thread was created, when the source says;
 *                  a thread first seen on the day it was created counts in full
 */
export function dayDelta(
  baselines: CumulativeBaselines,
  key: string,
  day: string,
  current: Buckets,
  createdOn: string | undefined,
  changed: { value: boolean }
): Buckets | null {
  const prior = baselines[key];
  if (!prior) {
    const base = createdOn === day ? ZERO : current;
    baselines[key] = { day, base: { ...base }, last: { ...current } };
    changed.value = true;
    return positive(minus(current, base));
  }
  if (day < prior.day) return null; // clock went backwards; never re-emit
  if (day > prior.day) {
    baselines[key] = { day, base: { ...prior.last }, last: { ...current } };
    changed.value = true;
  } else if (BUCKETS.some((b) => current[b] !== prior.last[b])) {
    // A total that went down (a thread reset, an id reused) starts a new run.
    // Shift the baseline by the drop so what this day already counted stays
    // counted and new growth adds on top: today only grows.
    for (const b of BUCKETS) {
      if (current[b] < prior.last[b]) prior.base[b] -= prior.last[b] - current[b];
    }
    prior.last = { ...current };
    changed.value = true;
  }
  return positive(minus(current, baselines[key]!.base));
}

function minus(a: Buckets, b: Buckets): Buckets {
  const out = { ...ZERO };
  for (const k of BUCKETS) out[k] = Math.max(0, (a[k] ?? 0) - (b[k] ?? 0));
  return out;
}

function positive(b: Buckets): Buckets | null {
  return BUCKETS.some((k) => b[k] > 0) ? b : null;
}
