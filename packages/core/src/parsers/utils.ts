/**
 * @sriinnu/tokmeter-core — Parser utilities.
 *
 * Shared helpers for session file discovery, reading, and record creation.
 */

import type { Dirent } from "node:fs";
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
import { loadConfig } from "../config-service.js";
import { localDateKey } from "../date-utils.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { ProviderId, TokenRecord, UsageProvenance, UsageTelemetrySource } from "../types.js";

// ─── Record Cache (append-aware, disk-persisted) ───────────────────
//
// Caches parsed TokenRecord[] per source file. Three modes:
//
// 1. EXACT HIT: mtime + size unchanged → return cached records (instant)
// 2. APPEND:    mtime changed but size grew → only parse new bytes from
//              the old offset (JSONL files are append-only)
// 3. MISS:      new file, or file shrunk/rewritten → full re-parse
//
// Persists to ~/.cache/tokmeter/scan-cache.json with metadata.
// Old files (from last month, last year) never need re-parsing again.

interface RecordCacheEntry {
  mtimeMs: number;
  sizeBytes: number;
  records: TokenRecord[];
}

interface CacheFile {
  version: number;
  createdAt: string;
  lastScanAt: string;
  /**
   * mtime of ~/.kosha/registry.json at the time records were priced. When
   * the current kosha mtime is newer, TokmeterCore knows to reprice on load
   * instead of trusting the frozen `cost` field on cached records.
   */
  koshaMtime?: number;
  stats: {
    files: number;
    records: number;
    cacheHits: number;
    cacheMisses: number;
    appends: number;
  };
  files: Record<string, RecordCacheEntry>;
}

let recordCache: Map<string, RecordCacheEntry> | null = null;
let cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
let cacheCreatedAt: string | null = null;
let cacheKoshaMtime = 0;
/** Set of paths touched in the current process so far — files we've actually
 *  observed live during a scan in this daemon lifetime. On save, paths in the
 *  cache that we've NOT touched recently AND that no longer exist on disk get
 *  dropped, so a long-lived daemon doesn't keep growing as the user cleans up
 *  or ages out old sessions. We rely on disk-existence (not "touched") as the
 *  drop condition so a quiet session file (claude-code project that wasn't
 *  active today) isn't evicted just because no parser visited it. */
let cacheTouchedPaths: Set<string> | null = null;
/** Throttle stale-path GC so a daemon scanning every 12s isn't fanning out N
 *  stats every tick. Run at most every ~5 minutes. */
let cacheLastGcAtMs = 0;
const CACHE_GC_INTERVAL_MS = 5 * 60 * 1000;
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
 *  4 — scan-cache now tracks koshaMtime for reactive repricing when the user
 *      updates ~/.kosha/registry.json (cost field is recomputed on load)
 *  5 — codex parser dedupes forked/replayed rollout files by root ancestor
 *      (fixes 5-10× cost inflation from `codex resume` creating siblings of
 *      the same session) — old caches have duplicated records and must be
 *      discarded to reflect the corrected totals
 *  6 — claude-code parser tags records as kind:"compaction" when a
 *      compact_boundary follows the assistant turn. Existing caches lack
 *      this field, so old records would silently mis-attribute compaction
 *      spend as normal turns. Force a re-parse so the new "% to compaction"
 *      signal is honest from the start.
 *  7 — claude-code parser extracts tool_use block names into TokenRecord.
 *      toolCalls so the bar can break out "% of today's spend by tool"
 *      (Bash, Read, Edit, Task, …). Existing caches don't carry the field
 *      so today's tool-cost view would be blank for cached records — force
 *      a re-parse.
 *  8 — claude-code parser now follows the depth bump (3->5) to pick up
 *      subagent JSONLs under <slug>/<sessionId>/subagents/agent-*.jsonl.
 *      These records were previously invisible (cost vanished from totals).
 *      Records from subagent files are tagged `isSubagent:true`. Existing
 *      caches lack the new files + flag — force a re-parse.
 *  9 — TokenRecord now carries usage provenance and optional compaction
 *      metadata. Old caches lack per-bucket trust markers, so rebuild once.
 */
const CACHE_VERSION = 9;

function loadRecordCache(): Map<string, RecordCacheEntry> {
  if (recordCache) return recordCache;
  recordCache = new Map();
  cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
  cacheKoshaMtime = 0;
  cacheTouchedPaths = new Set();
  cacheLastGcAtMs = 0;
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as CacheFile;
      // Reject old cache versions — fall through to empty map so all files
      // get re-parsed with the current parser semantics.
      if (data.version !== CACHE_VERSION) {
        // Flag the rebuild so a long re-parse on first scan after upgrade
        // doesn't look like a hung menubar. stderr keeps it out of stdout
        // (which CLI consumers might be piping into jq).
        console.warn(
          `[tokmeter] scan-cache schema bumped ${data.version} → ${CACHE_VERSION}, rebuilding from JSONL on next scan. One-time cost.`
        );
        cacheCreatedAt = new Date().toISOString();
        return recordCache;
      }
      cacheCreatedAt = data.createdAt;
      cacheKoshaMtime = data.koshaMtime ?? 0;
      for (const [k, v] of Object.entries(data.files)) {
        recordCache.set(k, v);
      }
    }
  } catch {}
  return recordCache;
}

/**
 * Throttled stale-path eviction. A long-lived daemon would otherwise carry
 * cache entries for every file ever scanned in its lifetime, even ones the
 * user has since deleted via `tokmeter cleanup` or that aged out of provider
 * retention. We sweep at most every {@link CACHE_GC_INTERVAL_MS} so a tight
 * scan loop (every 12 s) doesn't fan out N stats per tick.
 *
 * Eviction rule: a path is dropped only if (a) it wasn't observed live during
 * this process AND (b) it does not exist on disk. The "observed live" guard
 * keeps a quiet session file (e.g. a claude-code project the user didn't
 * touch today) safe — we only evict files that are genuinely gone. This is
 * safe to do synchronously: an evicted path that gets re-created later will
 * just miss the cache once and re-parse.
 */
function gcStalePathsIfDue(): void {
  if (!recordCache) return;
  const nowMs = Date.now();
  if (nowMs - cacheLastGcAtMs < CACHE_GC_INTERVAL_MS) return;
  cacheLastGcAtMs = nowMs;
  const touched = cacheTouchedPaths;
  if (!touched) return;
  for (const key of [...recordCache.keys()]) {
    if (touched.has(key)) continue;
    if (!existsSync(key)) {
      recordCache.delete(key);
    }
  }
}

function saveRecordCache(): void {
  if (!recordCache) return;
  try {
    gcStalePathsIfDue();
    if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
    const data: CacheFile = {
      version: CACHE_VERSION,
      createdAt: cacheCreatedAt || new Date().toISOString(),
      lastScanAt: new Date().toISOString(),
      koshaMtime: cacheKoshaMtime,
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

/** Kosha registry mtime associated with the currently-loaded cache, or 0. */
export function getCachedKoshaMtime(): number {
  loadRecordCache();
  return cacheKoshaMtime;
}

/** Record the kosha registry mtime that cached `cost` fields were priced against. */
export function setCachedKoshaMtime(mtimeMs: number): void {
  loadRecordCache();
  cacheKoshaMtime = mtimeMs;
}

/**
 * Check cache for a file. Returns one of:
 * - { hit: true, records } — exact match, skip parsing entirely
 * - { hit: false, appendOffset } — file grew, only parse from offset
 * - { hit: false, appendOffset: 0 } — full re-parse needed
 *
 * On miss/append the returned `statHint` is the stat used to decide the
 * branch. Parsers should pass it back to {@link setCachedRecords} so the
 * cache entry reflects the bytes actually parsed (closing the parse-time /
 * cache-set race that would otherwise let a concurrent writer's appended
 * bytes vanish on the next exact-match check).
 */
export async function getCachedRecords(path: string): Promise<
  | { hit: true; records: TokenRecord[] }
  | {
      hit: false;
      appendOffset: number;
      cachedRecords: TokenRecord[];
      statHint?: { mtimeMs: number; sizeBytes: number };
    }
> {
  const cache = loadRecordCache();
  // Record that we've observed this path live during this process — keeps the
  // GC sweep from evicting files we're actively scanning even if a transient
  // stat fails inside the sweep.
  cacheTouchedPaths?.add(path);
  const entry = cache.get(path);
  if (!entry) {
    cacheStats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [] };
  }
  try {
    const s = await stat(path);
    const statHint = { mtimeMs: s.mtimeMs, sizeBytes: s.size };
    // Exact hit: nothing changed
    if (s.mtimeMs === entry.mtimeMs && s.size === entry.sizeBytes) {
      cacheStats.cacheHits++;
      return { hit: true, records: entry.records };
    }
    // File grew: append-only parse from where we left off
    if (s.size > entry.sizeBytes) {
      cacheStats.appends++;
      return {
        hit: false,
        appendOffset: entry.sizeBytes,
        cachedRecords: entry.records,
        statHint,
      };
    }
    // File shrunk or rewritten: full re-parse
    cacheStats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [], statHint };
  } catch {
    cacheStats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [] };
  }
}

/**
 * Cache parsed records for a file, recording current mtime and size.
 *
 * Callers that already stat'd the file during parsing should pass `statHint`
 * — using the stat at parse-time keeps mtime/size in sync with what was
 * actually consumed. If we re-stat here, a writer that appends between parse
 * and cache-set would advance mtime/size, and the next scan's exact-match
 * check would skip the new bytes (silent token loss on append). The hint
 * closes that race.
 */
export async function setCachedRecords(
  path: string,
  records: TokenRecord[],
  statHint?: { mtimeMs: number; sizeBytes: number }
): Promise<void> {
  const cache = loadRecordCache();
  cacheTouchedPaths?.add(path);
  try {
    if (statHint) {
      cache.set(path, {
        mtimeMs: statHint.mtimeMs,
        sizeBytes: statHint.sizeBytes,
        records,
      });
      return;
    }
    const s = await stat(path);
    cache.set(path, { mtimeMs: s.mtimeMs, sizeBytes: s.size, records });
  } catch {}
}

/** Flush the in-memory record cache to disk. */
export function saveRecordCacheToDisk(): void {
  saveRecordCache();
}

/** Remove specific entries from both in-memory and disk cache (used after cleanup). */
export function invalidateRecordCache(paths: string[]): void {
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
export function clearRecordCache(): void {
  const cache = loadRecordCache();
  cache.clear();
  recordCache = cache;
  cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
  cacheTouchedPaths = new Set();
  cacheLastGcAtMs = 0;
  try {
    if (existsSync(CACHE_FILE)) {
      unlinkSync(CACHE_FILE);
    }
  } catch {}
}

/** Read only the tail of a file from a byte offset (for append-only parsing). */
export async function readJsonlFileFromOffset<T>(path: string, offsetBytes: number): Promise<T[]> {
  const { open } = await import("node:fs/promises");
  let fd: Awaited<ReturnType<typeof open>> | null = null;
  try {
    fd = await open(path, "r");
    const fileStat = await fd.stat();
    // Back up one byte so we can KNOW whether the offset was newline-aligned
    // instead of guessing from the first character. Sniffing for "{"/"[" drops
    // a legitimate complete record whenever a line doesn't start with those
    // (indentation, BOM, a future provider's format) — a silent token loss.
    // Reading offset-1 lets us check the actual boundary byte.
    const readFrom = offsetBytes > 0 ? offsetBytes - 1 : 0;
    const tailSize = fileStat.size - readFrom;
    if (tailSize <= 0) {
      return [];
    }
    const buf = Buffer.alloc(tailSize);
    await fd.read(buf, 0, tailSize, readFrom);

    const raw = buf.toString("utf-8");
    // 10 === "\n". If the byte just before the offset is a newline (or we read
    // from the very start), the tail begins on a clean line boundary and every
    // parsed line is complete. Otherwise the offset landed mid-line and the
    // first fragment is a partial JSON line that must be discarded.
    const alignedAtNewline = offsetBytes === 0 || raw.charCodeAt(0) === 10;
    let lines = raw.split("\n").filter((l: string) => l.trim());
    if (!alignedAtNewline && lines.length > 0) {
      lines = lines.slice(1);
    }

    const results: T[] = [];
    for (const line of lines) {
      try {
        results.push(JSON.parse(line) as T);
      } catch {}
    }
    return results;
  } catch {
    return [];
  } finally {
    // Guarantee the fd is released even if read() threw mid-buffer. Without
    // the finally, repeated parse failures would leak fds and eventually
    // panic the daemon with EMFILE.
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* close failure is best-effort */
      }
    }
  }
}

/**
 * Keep only files modified at or after `minMtimeMs`. Used by today-only scans
 * so a parser reads just the handful of files touched today instead of the
 * whole corpus. Stat-ing N files is orders of magnitude cheaper than reading
 * and parsing them — this is the difference between a ~30 MB statusline tick
 * and a 2 GB one. A file that contains today's records always has an mtime
 * today (records are appended, which advances mtime), so this can't drop a
 * today record. Stat failures are kept (fail-open: better a wasted read than a
 * lost record).
 */
export async function filterFilesByMtime(paths: string[], minMtimeMs: number): Promise<string[]> {
  const kept = await Promise.all(
    paths.map(async (p) => {
      try {
        const s = await stat(p);
        return s.mtimeMs >= minMtimeMs ? p : null;
      } catch {
        return p; // fail-open
      }
    })
  );
  return kept.filter((p): p is string => p !== null);
}

/**
 * Map `items` through `fn` with a bounded number of in-flight promises.
 *
 * Plain `Promise.all(items.map(fn))` fans out with NO ceiling: hand it a few
 * hundred files and every read/parse is scheduled at once, so V8 spends the
 * whole scan thrashing GC to resolve one giant promise-array while the event
 * loop starves (the daemon then can't answer the bar → it goes STALE). A small
 * worker pool keeps memory flat and the loop responsive; results stay in input
 * order so callers can zip them back to `items`.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  };
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

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
 * VS Code-family "User" data root candidates for a given set of app folder
 * names (e.g. ["Code", "Code - Insiders"]), across macOS, Linux, and Windows.
 *
 * Every Electron/VS Code fork (Code, Cursor, Windsurf, Antigravity, …) keeps
 * its per-user state under an app-named folder whose location is platform-
 * specific: `~/Library/Application Support/<App>` on macOS, `~/.config/<App>`
 * on Linux, `%APPDATA%/<App>` on Windows. Callers pass whichever of these
 * come back through `findFiles`, which fails soft on missing roots — so
 * candidates for platforms/apps that aren't installed are simply empty.
 */
export function vscodeFamilyUserDirs(appNames: string[], homeDir: string): string[] {
  const dirs: string[] = [];
  for (const app of appNames) {
    dirs.push(expandHome(`~/Library/Application Support/${app}/User`, homeDir));
    dirs.push(expandHome(`~/.config/${app}/User`, homeDir));
    dirs.push(expandHome(`~/AppData/Roaming/${app}/User`, homeDir));
  }
  return dirs;
}

/**
 * Extra search roots a user configured for this provider in
 * ~/.tokmeter/config.json (`providerPaths.<providerId>`) — the escape hatch
 * for installs this parser's own auto-detected candidates don't cover (a
 * non-standard location, an app rename this codebase hasn't caught up with
 * yet). Returns [] on any read/parse failure so a broken config file never
 * takes a provider's normal auto-detected paths down with it.
 *
 * Only useful for a provider whose *storage shape* still matches what the
 * parser expects, just at a different location — it can't make a parser
 * understand a genuinely different format.
 */
export function getConfiguredProviderPaths(providerId: ProviderId, homeDir: string): string[] {
  try {
    return loadConfig(homeDir).providerPaths[providerId] ?? [];
  } catch {
    return [];
  }
}

/** Extract the last path segment from either POSIX or Windows-style paths. */
export function lastPathSegment(path: string, fallback = "unknown"): string {
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
export async function findFiles(
  dir: string,
  predicate: (name: string) => boolean,
  maxDepth = 5,
  maxFiles = DEFAULT_MAX_FILES,
  isRoot = true
): Promise<string[]> {
  const results: string[] = [];
  if (maxDepth <= 0 || results.length >= maxFiles) return results;

  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    // Distinguish "not there" from "there but unreadable". A missing root dir
    // means the provider simply isn't installed → no data, not an error. But a
    // root that EXISTS yet fails to read (permissions, I/O, an unmounted
    // volume surfacing as EACCES/EIO) must NOT be silently treated as empty:
    // that would seal a day omitting real usage and freeze a wrong low number.
    // Propagate so the parser turns it into a provider warning, which makes
    // gap-fill refuse to seal that day (fail-closed) instead of losing data.
    // Nested subdir failures stay swallowed — one odd-permission subdir should
    // not fail the whole provider scan.
    const code = (error as NodeJS.ErrnoException).code;
    if (isRoot && code && code !== "ENOENT") throw error;
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
        maxFiles - results.length,
        false
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

/** Minimal read-only SQLite handle shared by the two available drivers. */
export interface ReadonlySqlite {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

/**
 * Opens a SQLite database read-only, picking the right driver for the
 * runtime: `bun:sqlite` under Bun, `better-sqlite3` under Node.
 *
 * better-sqlite3's native N-API bindings are not supported under Bun
 * (https://github.com/oven-sh/bun/issues/4290 — `dlopen` refuses to load
 * them, Bun's own error message points at `bun:sqlite` instead), so a
 * parser that only tries `better-sqlite3` silently returns zero records on
 * every Bun install, including this project's own dev/CLI runtime. Both
 * drivers are optional — a published npm consumer running under Node with
 * neither installed gets `null` back, not a crash.
 */
export async function openReadonlySqlite(path: string): Promise<ReadonlySqlite | null> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    try {
      // @ts-ignore — bun:sqlite only resolves under the Bun runtime
      const { Database } = await import("bun:sqlite");
      const db = new Database(path, { readonly: true });
      return {
        get: (sql, ...params) => db.query(sql).get(...params) as never,
        all: (sql, ...params) => db.query(sql).all(...params) as never,
        close: () => db.close(),
      };
    } catch {
      return null;
    }
  }
  try {
    // @ts-ignore — better-sqlite3 is an optional dependency
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path, { readonly: true });
    return {
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    };
  } catch {
    return null;
  }
}

/** Extract project name from a Claude Code session path. */
export function extractProjectFromPath(filePath: string): string {
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

type CreateRecordOverrides = Omit<Partial<TokenRecord>, "usage"> & {
  usage?: Partial<UsageProvenance>;
};

const directMetric = "direct" as const;
const notExposedMetric = "not_exposed" as const;
const calculatedMetric = "calculated" as const;
const normalizedMetric = "normalized" as const;

function baseProvenance(source: UsageTelemetrySource): UsageProvenance {
  return {
    source,
    inputTokens: directMetric,
    outputTokens: directMetric,
    cacheReadTokens: directMetric,
    cacheWriteTokens: directMetric,
    reasoningTokens: notExposedMetric,
    cost: calculatedMetric,
  };
}

function withMetrics(base: UsageProvenance, overrides: Partial<UsageProvenance>): UsageProvenance {
  return { ...base, ...overrides };
}

function defaultUsageProvenance(provider: ProviderId): UsageProvenance {
  switch (provider) {
    case "claude-code":
      return baseProvenance("tool_jsonl");
    case "codex":
      return {
        ...baseProvenance("tool_jsonl"),
        inputTokens: normalizedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: directMetric,
        notes: ["OpenAI-style total input is normalized to uncached input + cache read."],
      };
    case "gemini":
    case "qwen":
      return {
        ...baseProvenance(provider === "gemini" ? "tool_json" : "tool_jsonl"),
        inputTokens: normalizedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: directMetric,
        notes: ["Total prompt tokens are normalized to uncached input + cache read."],
      };
    case "cursor":
      return withMetrics(baseProvenance("tool_csv"), {
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
      });
    case "kilo-cli":
      return withMetrics(baseProvenance("tool_sqlite"), {
        reasoningTokens: directMetric,
      });
    case "opencode":
      return withMetrics(baseProvenance("tool_sqlite"), {
        reasoningTokens: directMetric,
      });
    case "kilo":
    case "roo-code":
      return baseProvenance("tool_json");
    case "mux":
      return withMetrics(baseProvenance("tool_json"), {
        reasoningTokens: directMetric,
      });
    case "openclaw":
      return withMetrics(baseProvenance("tool_jsonl"), {
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
      });
    case "vscode-copilot":
      return withMetrics(baseProvenance("tool_json"), {
        inputTokens: notExposedMetric,
        outputTokens: notExposedMetric,
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        cost: notExposedMetric,
        notes: [
          "GitHub Copilot bills via quota'd premium requests, not tokens — VS Code's local chat session store has no token/cost data, only model + request timestamps.",
        ],
      });
    case "antigravity":
      return withMetrics(baseProvenance("tool_sqlite"), {
        inputTokens: notExposedMetric,
        outputTokens: notExposedMetric,
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        cost: notExposedMetric,
        notes: [
          "Antigravity's local trajectory store has no public schema and, after manual decoding, exposes no model id, token count, or cost anywhere — only session timestamps and touched-file paths.",
        ],
      });
    case "zed":
      return withMetrics(baseProvenance("tool_sqlite"), {
        notes: [
          "Built from Zed's public open-source schema but not validated against a live Zed install — flag any discrepancy if Zed's format has moved.",
        ],
      });
    case "codex-desktop":
      return withMetrics(baseProvenance("tool_jsonl"), {
        inputTokens: notExposedMetric,
        outputTokens: notExposedMetric,
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
        cost: notExposedMetric,
        notes: [
          "The Codex Desktop app (bundled in ChatGPT.app) writes rollouts to the same ~/.codex/sessions store as the codex CLI but never emits a token_count event — only model + project + timestamp are available.",
        ],
      });
    case "synthetic":
      return withMetrics(baseProvenance("synthetic"), {
        inputTokens: calculatedMetric,
        outputTokens: calculatedMetric,
        cacheReadTokens: calculatedMetric,
        cacheWriteTokens: calculatedMetric,
        reasoningTokens: calculatedMetric,
        cost: calculatedMetric,
      });
    default:
      return baseProvenance("tool_jsonl");
  }
}

function mergeUsageProvenance(
  provider: ProviderId,
  overrides?: Partial<UsageProvenance>
): UsageProvenance {
  const defaults = defaultUsageProvenance(provider);
  if (!overrides) return defaults;
  return {
    ...defaults,
    ...overrides,
    notes: [...(defaults.notes ?? []), ...(overrides.notes ?? [])],
  };
}

/** Create a base token record with sensible defaults. */
export function createRecord(
  overrides: CreateRecordOverrides & Pick<TokenRecord, "timestamp" | "provider" | "model">
): TokenRecord {
  const ts =
    typeof overrides.timestamp === "number" && Number.isFinite(overrides.timestamp)
      ? overrides.timestamp
      : Date.now();
  const usage = mergeUsageProvenance(overrides.provider, overrides.usage);
  return {
    project: "unknown",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    cost: 0,
    ...overrides,
    usage,
    timestamp: ts,
  };
}

/** Format a timestamp (ms) to YYYY-MM-DD. */
export function toDateStr(ts: number): string {
  return localDateKey(ts);
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
