/**
 * @sriinnu/tokmeter-core — Frozen pre-today history snapshot storage.
 *
 * Persists records through yesterday so dashboards can reuse stable history
 * and only refresh today's overlay data unless a rescan or cleanup invalidates
 * the snapshot.
 */
import type { ScanWarning, TokenRecord } from "./types.js";
export interface LoadedHistorySnapshot {
  records: TokenRecord[];
  stableThrough: string | null;
  historySource: "snapshot" | "none";
  warnings: ScanWarning[];
}
/** Load the frozen pre-today history snapshot if it matches the requested day key. */
export declare function loadHistorySnapshot(
  homeDir: string,
  expectedStableThrough: string
): LoadedHistorySnapshot;
/** Persist the frozen pre-today history snapshot atomically. */
export declare function saveHistorySnapshot(
  homeDir: string,
  stableThrough: string,
  records: TokenRecord[]
): ScanWarning[];
/** Delete the frozen history snapshot after cleanup/restore so the next scan rebuilds it. */
export declare function invalidateHistorySnapshot(homeDir: string): void;
