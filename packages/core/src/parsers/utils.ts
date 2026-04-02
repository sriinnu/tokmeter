/**
 * @sriinnu/tokmeter-core — Parser utilities.
 *
 * Shared helpers for session file discovery, reading, and record creation.
 */

import type { Dirent } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { TokenRecord } from "../types.js";

/** Default maximum number of files returned by findFiles. */
const DEFAULT_MAX_FILES = 10_000;

/** Expand ~ to home directory. */
export function expandHome(path: string, homeDir: string): string {
  if (path.startsWith("~")) {
    return join(homeDir, path.slice(1));
  }
  return path;
}

/**
 * Recursively find files matching a predicate.
 *
 * @param dir       Root directory to search.
 * @param predicate Function to filter file names.
 * @param maxDepth  Maximum directory recursion depth (default 5).
 * @param maxFiles  Safety cap on total files returned (default 10 000).
 * @returns Array of absolute file paths.
 */
export async function findFiles(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth = 5,
  maxFiles = DEFAULT_MAX_FILES
): Promise<string[]> {
  const results: string[] = [];
  if (maxDepth <= 0 || results.length >= maxFiles) return results;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (results.length >= maxFiles) break;

    // Skip symlink directories to prevent path traversal attacks
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      const sub = await findFiles(
        join(dir, entry.name),
        predicate,
        maxDepth - 1,
        maxFiles - results.length
      );
      results.push(...sub);
    } else if (entry.isFile() && !entry.isSymbolicLink() && predicate(entry.name)) {
      results.push(join(dir, entry.name));
    }
    // Silently skip symlinks and other special file types
  }
  return results;
}

/** Read and parse JSON safely. */
export async function readJsonFile<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** Read JSONL file and parse each line. */
export async function readJsonlFile<T>(path: string): Promise<T[]> {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter((l: string) => l.trim());
    const results: T[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as T);
      } catch {
        // skip malformed lines
      }
    }
    return results;
  } catch {
    return [];
  }
}

/** Extract project name from a Claude Code session path. */
export function extractProjectFromPath(filePath: string): string {
  // ~/.claude/projects/-Users-me-myapp/session.jsonl → -Users-me-myapp
  // or just use the parent directory name
  const parts = filePath.split("/");
  // Find "projects" in path and take next segment
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && parts[projectsIdx + 1]) {
    return parts[projectsIdx + 1];
  }
  // Fallback: use parent directory name
  return parts[parts.length - 2] || "unknown";
}

/** Create a base token record with sensible defaults. */
export function createRecord(
  overrides: Partial<TokenRecord> & Pick<TokenRecord, "timestamp" | "provider" | "model">
): TokenRecord {
  const ts =
    typeof overrides.timestamp === "number" && Number.isFinite(overrides.timestamp)
      ? overrides.timestamp
      : Date.now();
  return {
    project: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    ...overrides,
    timestamp: ts,
  };
}

/** Format a timestamp (ms) to YYYY-MM-DD. */
export function toDateStr(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Check if a file exists. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

/** Check if a directory exists. */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
