/**
 * @sriinnu/tokmeter-core — Parser utilities.
 *
 * Shared helpers for session file discovery, reading, and record creation.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { localDateKey } from "../date-utils.js";
import { canonicalizeProjectName } from "../project-name.js";
let recordCache = null;
let cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
let cacheCreatedAt = null;
const CACHE_DIR = join(process.env.HOME || "", ".cache", "tokmeter");
const CACHE_FILE = join(CACHE_DIR, "scan-cache.json");
/**
 * Cache schema version. Bump this whenever a parser changes how it derives
 * tokens or cost from the source files — old cached records will become
 * invalid and we want to force a fresh scan instead of serving stale data.
 *
 * Version history:
 *  1 — initial
 *  2 — codex/qwen/gemini parsers now subtract cached_input from input_tokens
 *      to match Anthropic semantics (was double-counting cached tokens)
 *  3 — codex parser fixed duplicate records from last_token_usage fallback
 *      (~7% of Codex records were phantom duplicates inflating cost by ~10%)
 */
const CACHE_VERSION = 3;
function loadRecordCache() {
  if (recordCache) return recordCache;
  recordCache = new Map();
  cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      // Reject old cache versions — fall through to empty map so all files
      // get re-parsed with the current parser semantics.
      if (data.version !== CACHE_VERSION) {
        cacheCreatedAt = new Date().toISOString();
        return recordCache;
      }
      cacheCreatedAt = data.createdAt;
      for (const [k, v] of Object.entries(data.files)) {
        recordCache.set(k, v);
      }
    }
  } catch {}
  return recordCache;
}
function saveRecordCache() {
  if (!recordCache) return;
  try {
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const data = {
      version: CACHE_VERSION,
      createdAt: cacheCreatedAt || new Date().toISOString(),
      lastScanAt: new Date().toISOString(),
      stats: {
        ...cacheStats,
        files: recordCache.size,
        records: [...recordCache.values()].reduce((s, e) => s + e.records.length, 0),
      },
      files: Object.fromEntries(recordCache),
    };
    // Atomic write: tmp file + rename prevents corruption from concurrent processes
    const tmpFile = `${CACHE_FILE}.tmp`;
    writeFileSync(tmpFile, JSON.stringify(data));
    renameSync(tmpFile, CACHE_FILE);
  } catch {}
}
/**
 * Check cache for a file. Returns one of:
 * - { hit: true, records } — exact match, skip parsing entirely
 * - { hit: false, appendOffset } — file grew, only parse from offset
 * - { hit: false, appendOffset: 0 } — full re-parse needed
 */
export async function getCachedRecords(path) {
  const cache = loadRecordCache();
  const entry = cache.get(path);
  if (!entry) {
    cacheStats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [] };
  }
  try {
    const s = await stat(path);
    // Exact hit: nothing changed
    if (s.mtimeMs === entry.mtimeMs && s.size === entry.sizeBytes) {
      cacheStats.cacheHits++;
      return { hit: true, records: entry.records };
    }
    // File grew: append-only parse from where we left off
    if (s.size > entry.sizeBytes) {
      cacheStats.appends++;
      return { hit: false, appendOffset: entry.sizeBytes, cachedRecords: entry.records };
    }
    // File shrunk or rewritten: full re-parse
    cacheStats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [] };
  } catch {
    cacheStats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [] };
  }
}
/**
 * Cache parsed records for a file, recording current mtime and size.
 */
export async function setCachedRecords(path, records) {
  const cache = loadRecordCache();
  try {
    const s = await stat(path);
    cache.set(path, { mtimeMs: s.mtimeMs, sizeBytes: s.size, records });
  } catch {}
}
/** Flush the in-memory record cache to disk. */
export function saveRecordCacheToDisk() {
  saveRecordCache();
}
/** Remove specific entries from both in-memory and disk cache (used after cleanup). */
export function invalidateRecordCache(paths) {
  const cache = loadRecordCache();
  for (const p of paths) {
    cache.delete(p);
    const directoryPrefix = p.endsWith("/") || p.endsWith("\\") ? p : `${p}/`;
    const windowsDirectoryPrefix = p.endsWith("\\") || p.endsWith("/") ? p : `${p}\\`;
    for (const key of cache.keys()) {
      if (key.startsWith(directoryPrefix) || key.startsWith(windowsDirectoryPrefix)) {
        cache.delete(key);
      }
    }
  }
  saveRecordCache();
}
/** Clear the entire record cache, forcing a full rescan. */
export function clearRecordCache() {
  const cache = loadRecordCache();
  cache.clear();
  recordCache = cache;
  cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
  try {
    if (existsSync(CACHE_FILE)) {
      unlinkSync(CACHE_FILE);
    }
  } catch {}
}
/** Read only the tail of a file from a byte offset (for append-only parsing). */
export async function readJsonlFileFromOffset(path, offsetBytes) {
  try {
    const fd = await import("node:fs/promises").then((m) => m.open(path, "r"));
    const fileStat = await fd.stat();
    const tailSize = fileStat.size - offsetBytes;
    if (tailSize <= 0) {
      await fd.close();
      return [];
    }
    const buf = Buffer.alloc(tailSize);
    await fd.read(buf, 0, tailSize, offsetBytes);
    await fd.close();
    const raw = buf.toString("utf-8");
    let lines = raw.split("\n").filter((l) => l.trim());
    // If offset landed mid-line, the first chunk is a partial JSON line — discard it
    if (lines.length > 0 && !raw.startsWith("\n") && !raw.startsWith("{") && !raw.startsWith("[")) {
      lines = lines.slice(1);
    }
    const results = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line));
      } catch {}
    }
    return results;
  } catch {
    return [];
  }
}
/** Default maximum number of files returned by findFiles. */
const DEFAULT_MAX_FILES = 10_000;
/** Expand ~ to home directory. */
export function expandHome(path, homeDir) {
  if (path.startsWith("~")) {
    return join(homeDir, path.slice(1));
  }
  return path;
}
/** Extract the last path segment from either POSIX or Windows-style paths. */
export function lastPathSegment(path, fallback = "unknown") {
  const normalizedPath = path.replace(/[\\/]+$/g, "");
  const segments = normalizedPath.split(/[\\/]+/).filter(Boolean);
  return segments[segments.length - 1] || fallback;
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
export async function findFiles(dir, predicate, maxDepth = 5, maxFiles = DEFAULT_MAX_FILES) {
  const results = [];
  if (maxDepth <= 0 || results.length >= maxFiles) return results;
  let entries;
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
export async function readJsonFile(path) {
  try {
    const raw = await readFile(path, "utf-8");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
/** Read JSONL file and parse each line. */
export async function readJsonlFile(path) {
  try {
    const raw = await readFile(path, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const results = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line));
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
export function extractProjectFromPath(filePath) {
  // ~/.claude/projects/-Users-me-myapp/session.jsonl → -Users-me-myapp
  // or just use the parent directory name
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  // Find "projects" in path and take next segment
  const projectsIdx = parts.indexOf("projects");
  if (projectsIdx >= 0 && parts[projectsIdx + 1]) {
    return canonicalizeProjectName(parts[projectsIdx + 1], "unknown");
  }
  // Fallback: use parent directory name
  return canonicalizeProjectName(parts[parts.length - 2] || "unknown", "unknown");
}
/** Create a base token record with sensible defaults. */
export function createRecord(overrides) {
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
export function toDateStr(ts) {
  return localDateKey(ts);
}
/** Check if a file exists. */
export async function fileExists(path) {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
/** Check if a directory exists. */
export async function dirExists(path) {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}
