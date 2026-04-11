/**
 * @sriinnu/tokmeter-core — Parser utilities.
 *
 * Shared helpers for session file discovery, reading, and record creation.
 */
import type { TokenRecord } from "../types.js";
/**
 * Check cache for a file. Returns one of:
 * - { hit: true, records } — exact match, skip parsing entirely
 * - { hit: false, appendOffset } — file grew, only parse from offset
 * - { hit: false, appendOffset: 0 } — full re-parse needed
 */
export declare function getCachedRecords(path: string): Promise<
  | {
      hit: true;
      records: TokenRecord[];
    }
  | {
      hit: false;
      appendOffset: number;
      cachedRecords: TokenRecord[];
    }
>;
/**
 * Cache parsed records for a file, recording current mtime and size.
 */
export declare function setCachedRecords(path: string, records: TokenRecord[]): Promise<void>;
/** Flush the in-memory record cache to disk. */
export declare function saveRecordCacheToDisk(): void;
/** Remove specific entries from both in-memory and disk cache (used after cleanup). */
export declare function invalidateRecordCache(paths: string[]): void;
/** Clear the entire record cache, forcing a full rescan. */
export declare function clearRecordCache(): void;
/** Read only the tail of a file from a byte offset (for append-only parsing). */
export declare function readJsonlFileFromOffset<T>(path: string, offsetBytes: number): Promise<T[]>;
/** Expand ~ to home directory. */
export declare function expandHome(path: string, homeDir: string): string;
/** Extract the last path segment from either POSIX or Windows-style paths. */
export declare function lastPathSegment(path: string, fallback?: string): string;
/**
 * Recursively find files matching a predicate.
 *
 * @param dir       Root directory to search.
 * @param predicate Function to filter file names.
 * @param maxDepth  Maximum directory recursion depth (default 5).
 * @param maxFiles  Safety cap on total files returned (default 10 000).
 * @returns Array of absolute file paths.
 */
export declare function findFiles(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth?: number,
  maxFiles?: number
): Promise<string[]>;
/** Read and parse JSON safely. */
export declare function readJsonFile<T>(path: string): Promise<T | null>;
/** Read JSONL file and parse each line. */
export declare function readJsonlFile<T>(path: string): Promise<T[]>;
/** Extract project name from a Claude Code session path. */
export declare function extractProjectFromPath(filePath: string): string;
/** Create a base token record with sensible defaults. */
export declare function createRecord(
  overrides: Partial<TokenRecord> & Pick<TokenRecord, "timestamp" | "provider" | "model">
): TokenRecord;
/** Format a timestamp (ms) to YYYY-MM-DD. */
export declare function toDateStr(ts: number): string;
/** Check if a file exists. */
export declare function fileExists(path: string): Promise<boolean>;
/** Check if a directory exists. */
export declare function dirExists(path: string): Promise<boolean>;
