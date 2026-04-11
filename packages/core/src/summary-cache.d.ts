import type { ScanWarning, TokmeterSummary } from "./types.js";
export interface LoadedSummaryCache {
  summary: TokmeterSummary | null;
  warnings: ScanWarning[];
}
/**
 * Load the persisted full-summary cache if present and compatible.
 */
export declare function loadSummaryCache(homeDir: string): LoadedSummaryCache;
/**
 * Persist the full summary cache atomically for browser and daemon fallback.
 */
export declare function saveSummaryCache(homeDir: string, summary: TokmeterSummary): ScanWarning[];
/**
 * Remove the persisted summary cache after cleanup or restore.
 */
export declare function invalidateSummaryCache(homeDir: string): void;
