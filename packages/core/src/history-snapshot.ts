/**
 * @sriinnu/tokmeter-core — Frozen pre-today history snapshot storage.
 *
 * Persists records through yesterday so dashboards can reuse stable history
 * and only refresh today's overlay data unless a rescan or cleanup invalidates
 * the snapshot.
 *
 * ─── Schema versions ─────────────────────────────────────────────────────────
 *
 *   v2 (legacy)   — `records: TokenRecord[]` — every record materialized; the
 *                   daemon used to hold all 270k+ raw records resident, which
 *                   is the 1.5 GB warm set we are eliminating.
 *
 *   v3 (target)   — `days: DailyAggregate[]` — per-day rollups (per-model +
 *                   per-project + per-provider buckets, sums, recordCount).
 *                   Same answers, ~30× smaller on disk, ~50× smaller in heap.
 *                   The "relay race" architecture: a completed day hands the
 *                   baton to its aggregate row — provider JSONLs are NEVER
 *                   re-read for it again.
 *
 * This file READS both formats; v2 files have their `records` rolled up via
 * {@link aggregateRecordsByDay} so callers can already consume the aggregate
 * shape today. The WRITER still emits v2 until Slice 3 cuts over — that's
 * intentional so this slice is purely additive (no on-disk format change yet,
 * no consumer break).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type DailyAggregate, aggregateRecordsByDay } from "./aggregates.js";
import type { ScanWarning, TokenRecord } from "./types.js";

/** v2 — legacy raw-records on-disk shape. Still the canonical writer for now. */
interface HistorySnapshotV2File {
  version: 2;
  stableThrough: string;
  createdAt: string;
  updatedAt: string;
  records: TokenRecord[];
}

/** v3 — aggregate on-disk shape. Read-supported here; written by Slice 3. */
interface HistorySnapshotV3File {
  version: 3;
  stableThrough: string;
  createdAt: string;
  updatedAt: string;
  days: DailyAggregate[];
}

/** Either schema, distinguished by `version`. */
type HistorySnapshotFile = HistorySnapshotV2File | HistorySnapshotV3File;

export interface LoadedHistorySnapshot {
  /**
   * Raw records, populated ONLY for v2 files. v3 files return an empty array
   * here — callers that haven't migrated to the aggregate API still compile
   * but get no historical raw records (which is the entire point of the v3
   * cutover). Slice 3 retires `this.records` from TokmeterCore.
   */
  records: TokenRecord[];
  /**
   * Per-day aggregates, ALWAYS populated when a usable snapshot loads — for
   * v3 directly from the file, for v2 derived lazily via
   * {@link aggregateRecordsByDay}. New consumers should read this; legacy
   * consumers can still touch `records` until they migrate.
   */
  aggregates: DailyAggregate[];
  /**
   * The on-disk schema version of the file we actually loaded. Lets the
   * caller decide whether to rewrite as v3 (one-shot upgrade) or leave alone.
   */
  loadedVersion: 2 | 3 | null;
  /**
   * The day key the snapshot was actually frozen through. May be OLDER than
   * the day we asked for — that's the append-only signal: the caller keeps
   * these records as the frozen base and only freezes the gap days on top,
   * instead of discarding and re-deriving everything from disk.
   */
  storedStableThrough: string | null;
  /** True when {@link storedStableThrough} exactly equals the requested key. */
  matchesExpected: boolean;
  historySource: "snapshot" | "none";
  warnings: ScanWarning[];
}

/** Sum of every token bucket across records — used by the monotonic floor guard. */
export function sumSnapshotTokens(records: TokenRecord[]): number {
  let total = 0;
  for (const r of records) {
    total +=
      r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheWriteTokens + r.reasoningTokens;
  }
  return total;
}

/**
 * Monotonic floor for frozen history. A full rebuild whose total tokens fall
 * below this fraction of the existing frozen snapshot is treated as a partial
 * or failed scan. Set deliberately low — catch catastrophes (a whole provider
 * dropping out), not normal parser-correctness drift. An explicit rescan always
 * overrides it.
 */
export const HISTORY_FLOOR_RATIO = 0.5;

/**
 * Decide whether a freshly-rebuilt history should REPLACE the existing frozen
 * snapshot, or whether the existing one should be kept to avoid clobbering
 * frozen history with a partial/degraded scan. Pure so it can be unit-tested.
 */
export function shouldKeepExistingHistory(
  existingTokens: number,
  rebuiltTokens: number,
  opts: { forceRescan: boolean; providerFailed: boolean }
): boolean {
  if (opts.forceRescan) return false; // user asked for fresh truth — honor it.
  if (existingTokens <= 0) return false; // nothing to protect.
  // A provider scan failed → the rebuild is missing data we already had frozen.
  if (opts.providerFailed) return true;
  // Catastrophic shrink even without an explicit failure (capped scan, etc.).
  return rebuiltTokens < existingTokens * HISTORY_FLOOR_RATIO;
}

/**
 * Current preferred writer version. The writer (`saveHistorySnapshot`) emits
 * this format. Bumped to 3 in Slice 3 once consumers are aggregate-aware;
 * holding at 2 here so this slice stays additive — no on-disk format change.
 */
const HISTORY_SNAPSHOT_VERSION = 2 as const;

/**
 * Every version `loadHistorySnapshot` knows how to read. Older / unknown
 * versions trigger a rebuild. v2 is the legacy raw-records format, v3 is the
 * target aggregate format (read-only here; written by Slice 3).
 */
const SUPPORTED_VERSIONS: ReadonlySet<number> = new Set([2, 3]);

const SNAPSHOT_DIR_NAME = ".cache/tokmeter";
const SNAPSHOT_FILE_NAME = "history-snapshot.json";

function snapshotDir(homeDir: string): string {
  return join(homeDir, SNAPSHOT_DIR_NAME);
}

function snapshotPath(homeDir: string): string {
  return join(snapshotDir(homeDir), SNAPSHOT_FILE_NAME);
}

/**
 * Load the frozen pre-today history snapshot.
 *
 * Unlike the original behaviour, this no longer throws away a snapshot whose
 * `stableThrough` is OLDER than what we asked for. A stale-but-valid snapshot
 * is returned with `matchesExpected: false` so the caller can EXTEND it
 * (append the newly-frozen gap days) rather than re-deriving — and repricing —
 * all of history from disk on every calendar rollover. That re-derivation was
 * the root of the "tokens/cost keep depleting" bug: a transient provider hiccup
 * or a record-cache version bump would silently rewrite the frozen past.
 *
 * Only a schema-version change or an unreadable file forces a full rebuild.
 */
export function loadHistorySnapshot(
  homeDir: string,
  expectedStableThrough: string
): LoadedHistorySnapshot {
  const warnings: ScanWarning[] = [];
  const filePath = snapshotPath(homeDir);

  if (!existsSync(filePath)) {
    return {
      records: [],
      aggregates: [],
      loadedVersion: null,
      storedStableThrough: null,
      matchesExpected: false,
      historySource: "none",
      warnings,
    };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const snapshot = JSON.parse(raw) as HistorySnapshotFile;

    if (!SUPPORTED_VERSIONS.has(snapshot.version)) {
      warnings.push({
        scope: "history",
        message:
          `History snapshot version ${snapshot.version} is not supported by this build — ` +
          "rebuilding frozen history.",
      });
      return {
        records: [],
        aggregates: [],
        loadedVersion: null,
        storedStableThrough: snapshot.stableThrough ?? null,
        matchesExpected: false,
        historySource: "none",
        warnings,
      };
    }

    const storedStableThrough = snapshot.stableThrough ?? null;
    const matchesExpected = snapshot.stableThrough === expectedStableThrough;

    if (snapshot.version === 3) {
      // v3 — aggregates are first-class on disk. No raw records to expose;
      // callers must read `aggregates`. (Slice 3 retires `records` from
      // TokmeterCore — for now legacy callers will see an empty array, which
      // is the correct "no raw historical records available" signal.)
      return {
        records: [],
        aggregates: snapshot.days ?? [],
        loadedVersion: 3,
        storedStableThrough,
        matchesExpected,
        historySource: "snapshot",
        warnings,
      };
    }

    // v2 — raw records on disk. Derive aggregates so new consumers can
    // already read the aggregate API without waiting for the writer cutover.
    // Cheap: O(N) single-pass roll-up over the same records the file holds.
    const records = snapshot.records ?? [];
    return {
      records,
      aggregates: aggregateRecordsByDay(records),
      loadedVersion: 2,
      storedStableThrough,
      matchesExpected,
      historySource: "snapshot",
      warnings,
    };
  } catch (error) {
    warnings.push({
      scope: "history",
      message: `History snapshot read failed — rebuilding frozen history (${toErrorMessage(error)}).`,
    });

    return {
      records: [],
      aggregates: [],
      loadedVersion: null,
      storedStableThrough: null,
      matchesExpected: false,
      historySource: "none",
      warnings,
    };
  }
}

/** Persist the frozen pre-today history snapshot atomically. */
export function saveHistorySnapshot(
  homeDir: string,
  stableThrough: string,
  records: TokenRecord[]
): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  const dir = snapshotDir(homeDir);
  const filePath = snapshotPath(homeDir);
  const tempFilePath = `${filePath}.tmp`;

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const now = new Date().toISOString();
    const snapshot: HistorySnapshotV2File = {
      version: HISTORY_SNAPSHOT_VERSION,
      stableThrough,
      createdAt: now,
      updatedAt: now,
      records,
    };

    writeFileSync(tempFilePath, JSON.stringify(snapshot), "utf-8");
    renameSync(tempFilePath, filePath);
  } catch (error) {
    warnings.push({
      scope: "cache",
      message: `History snapshot write failed — continuing with live data only (${toErrorMessage(error)}).`,
    });
  }

  return warnings;
}

/**
 * Persist the frozen pre-today history snapshot in v3 (aggregates) format.
 * Slice 3 swaps this in as the canonical writer once TokmeterCore stops
 * materializing raw historical records. Until then, this is parallel
 * infrastructure — safe to call but not yet on any hot path.
 */
export function saveHistorySnapshotV3(
  homeDir: string,
  stableThrough: string,
  days: DailyAggregate[]
): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  const dir = snapshotDir(homeDir);
  const filePath = snapshotPath(homeDir);
  const tempFilePath = `${filePath}.tmp`;

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const now = new Date().toISOString();
    const snapshot: HistorySnapshotV3File = {
      version: 3,
      stableThrough,
      createdAt: now,
      updatedAt: now,
      days,
    };

    writeFileSync(tempFilePath, JSON.stringify(snapshot), "utf-8");
    renameSync(tempFilePath, filePath);
  } catch (error) {
    warnings.push({
      scope: "cache",
      message: `History snapshot v3 write failed — continuing with live data only (${toErrorMessage(error)}).`,
    });
  }

  return warnings;
}

/**
 * Total token count across a set of aggregates — same role as
 * {@link sumSnapshotTokens} for the floor guard, but operating on the v3
 * aggregate shape.
 */
export function sumAggregateTokens(days: DailyAggregate[]): number {
  let total = 0;
  for (const d of days) total += d.totalTokens;
  return total;
}

/** Delete the frozen history snapshot after cleanup/restore so the next scan rebuilds it. */
export function invalidateHistorySnapshot(homeDir: string): void {
  const filePath = snapshotPath(homeDir);

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Non-blocking by design — callers should continue even if cache cleanup fails.
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
