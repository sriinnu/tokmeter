/**
 * @sriinnu/tokmeter-core — Parser utilities.
 *
 * Shared helpers for session file discovery, reading, and record creation.
 */

import type { Dirent } from "node:fs";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { type FileHandle, open, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../config-service.js";
import { localDateKey } from "../date-utils.js";
import { sanitizeDataLabel } from "../display-safety.js";
import { ensurePrivateDirectory, ensurePrivateFile, writePrivateFile } from "../private-files.js";
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
  /**
   * mtime of ~/.tokmeter/pricing-overrides.json when today's records were
   * priced (0 = no overrides file). An override edit reprices today the same
   * way a kosha refresh does. Optional: older caches read as 0.
   */
  overridesMtime?: number;
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
let cacheOverridesMtime = 0;
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
 * 10 — Codex output_tokens includes reasoning_output_tokens. Normalize the
 *      output bucket to visible output so aggregate totals and pricing do not
 *      count the same generated tokens twice.
 */
// 11 — Codex per-response token_usage_record support and unknown model fallback.
// 12 — Preserve explicit tool-reported zero cost instead of repricing it.
// 13 — claude-code parser dedups on message.id+requestId (one record per API
//      response). Timestamp-keyed dedup counted a turn once per content-block
//      line — a parallel-tool-call turn N times. Cached records are inflated;
//      rebuild.
// 14 — claude-code records carry cacheWrite1hTokens (the 1h-TTL share of cache
//      writes, billed at 2× input vs 1.25× for 5m). Cached records lack the
//      field and were priced as if every write were 5m; rebuild.
// 15 — claude-code dedup keeps the MAX usage across a response's lines, not
//      the first: subagent transcripts open with placeholder usage from
//      message_start and only the last line carries real output tokens.
//      v13/v14 caches hold first-line values for subagent turns; rebuild.
// 17 — opencode/kilo-cli read the current `message.data` JSON schema (the
//      flat `messages` query threw, so every DB-era message was dropped) and
//      opencode merges legacy JSON with the DB instead of either-or.
// 18 — opencode free-tier ($0, `-free`/`:free`) records carry cost provenance
//      "direct", so they render $0.00 instead of "Unavailable". Same for
//      custom-source lines served by a local runtime (Ollama, LM Studio, …).
// 19 — codex reads compressed (.jsonl.zst) and archived rollouts, which it
//      had skipped entirely; also covers #135's chitragupta provider label.
// 20/21 — display hardening and bounded streaming parser revisions.
// 22 — Claude append scans cache the exact descriptor snapshot boundary;
//      older entries can double-count bytes appended during a scan.
// 23 — bounded JSONL snapshots and cached-record totals prevent append-mode
//      sessions from bypassing the per-read memory limits.
const CACHE_VERSION = 23;

function loadRecordCache(): Map<string, RecordCacheEntry> {
  if (recordCache) return recordCache;
  recordCache = new Map();
  cacheStats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
  cacheKoshaMtime = 0;
  cacheOverridesMtime = 0;
  cacheTouchedPaths = new Set();
  cacheLastGcAtMs = 0;
  try {
    ensurePrivateDirectory(CACHE_DIR);
    ensurePrivateFile(CACHE_FILE);
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
      cacheOverridesMtime = data.overridesMtime ?? 0;
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
    ensurePrivateDirectory(CACHE_DIR);
    const data: CacheFile = {
      version: CACHE_VERSION,
      createdAt: cacheCreatedAt || new Date().toISOString(),
      lastScanAt: new Date().toISOString(),
      koshaMtime: cacheKoshaMtime,
      overridesMtime: cacheOverridesMtime,
      stats: {
        ...cacheStats,
        files: recordCache.size,
        records: [...recordCache.values()].reduce((s, e) => s + e.records.length, 0),
      },
      files: Object.fromEntries(recordCache),
    };
    // Atomic write: tmp file + rename prevents corruption from concurrent processes
    writePrivateFile(CACHE_FILE, JSON.stringify(data));
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

/** Pricing-overrides mtime associated with the currently-loaded cache, or 0. */
export function getCachedOverridesMtime(): number {
  loadRecordCache();
  return cacheOverridesMtime;
}

/** Record the pricing-overrides mtime that today's cached costs were priced against. */
export function setCachedOverridesMtime(mtimeMs: number): void {
  loadRecordCache();
  cacheOverridesMtime = mtimeMs;
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
/**
 * Records last parsed for a file, straight from the in-memory cache — no stat,
 * no freshness check, never touches disk. For hot-path readers (a statusline
 * tick) that want "everything the daemon has parsed from this transcript"
 * and can tolerate the tail being as stale as the daemon's refresh cadence.
 */
export function peekCachedRecords(path: string): TokenRecord[] | null {
  return loadRecordCache().get(path)?.records ?? null;
}

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

/** Read only the tail of a file from a byte offset (for append-only parsing).
 *  A bounded-parser fault returns records completed before the fault and calls
 *  `onError`; callers must treat that scan as incomplete and never seal it. */
export async function readJsonlFileFromOffset<T>(
  path: string,
  offsetBytes: number,
  onError?: (error: unknown) => void,
  onSnapshot?: (snapshot: { mtimeMs: number; sizeBytes: number }) => void
): Promise<T[]> {
  let fd: FileHandle | null = null;
  try {
    fd = await open(path, "r");
    const fileStat = await fd.stat();
    onSnapshot?.({ mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size });
    if (fileStat.size > MAX_JSONL_INPUT_BYTES) {
      throw new JsonlLimitError(
        path,
        `snapshot limit (${MAX_JSONL_INPUT_BYTES} bytes) exceeded`,
        []
      );
    }
    if (offsetBytes >= fileStat.size) {
      return [];
    }
    let discardFirstFragment = false;
    if (offsetBytes > 0) {
      const boundary = Buffer.alloc(1);
      await fd.read(boundary, 0, 1, offsetBytes - 1);
      discardFirstFragment = boundary[0] !== 10;
    }
    // Read from the same descriptor we statted and stop at that exact byte
    // boundary. A provider can append while we parse; following a separately
    // opened path beyond fileStat.size would cache bytes that the cache's
    // statHint does not cover, then count them again on the next append scan.
    return await streamJsonlFile<T>(fd, path, offsetBytes, fileStat.size - 1, discardFirstFragment);
  } catch (error) {
    if (!onError) throw error;
    onError(error);
    return error instanceof JsonlLimitError ? (error.partialResults as T[]) : [];
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

const MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024;
export const MAX_JSONL_RECORDS = 600_000;
const MAX_JSONL_INPUT_BYTES = 128 * 1024 * 1024;

class JsonlLimitError extends Error {
  readonly partialResults: unknown[];

  constructor(path: string, problem: string, partialResults: unknown[]) {
    super(`Refusing to parse ${path}: JSONL ${problem}`);
    this.name = "JsonlLimitError";
    this.partialResults = partialResults;
  }
}

async function streamJsonlFile<T>(
  fd: FileHandle,
  path: string,
  startBytes = 0,
  endBytes = Number.POSITIVE_INFINITY,
  discardFirstFragment = false
): Promise<T[]> {
  const results: T[] = [];
  let pending = "";
  let discarding = discardFirstFragment;
  let inputBytes = 0;
  const stream = fd.createReadStream({
    encoding: "utf8",
    start: startBytes,
    ...(Number.isFinite(endBytes) ? { end: endBytes } : {}),
    autoClose: false,
  });

  const parseLine = (line: string): void => {
    if (!line.trim()) return;
    if (line.length > MAX_JSONL_LINE_CHARS) {
      throw new JsonlLimitError(
        path,
        `line limit (${MAX_JSONL_LINE_CHARS} characters) exceeded`,
        results
      );
    }
    if (results.length >= MAX_JSONL_RECORDS) {
      throw new JsonlLimitError(path, `record limit (${MAX_JSONL_RECORDS}) exceeded`, results);
    }
    try {
      results.push(JSON.parse(line) as T);
    } catch {
      throw new JsonlLimitError(path, "malformed complete JSON line", results);
    }
  };

  for await (const chunk of stream) {
    inputBytes += Buffer.byteLength(chunk);
    if (inputBytes > MAX_JSONL_INPUT_BYTES) {
      throw new JsonlLimitError(
        path,
        `input limit (${MAX_JSONL_INPUT_BYTES} bytes) exceeded`,
        results
      );
    }
    pending += chunk;
    if (pending.length > MAX_JSONL_LINE_CHARS && !pending.includes("\n")) {
      throw new JsonlLimitError(
        path,
        `line limit (${MAX_JSONL_LINE_CHARS} characters) exceeded`,
        results
      );
    }

    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (discarding) discarding = false;
      else parseLine(line);
      newline = pending.indexOf("\n");
    }
  }

  if (!discarding && pending.length > 0) {
    // A valid JSON value does not require a trailing newline. A malformed
    // unterminated tail is different from a malformed complete line: it can be
    // an ordinary provider write caught in flight and must not advance caches.
    if (pending.trim()) {
      if (pending.length > MAX_JSONL_LINE_CHARS) {
        throw new JsonlLimitError(
          path,
          `line limit (${MAX_JSONL_LINE_CHARS} characters) exceeded`,
          results
        );
      }
      if (results.length >= MAX_JSONL_RECORDS) {
        throw new JsonlLimitError(path, `record limit (${MAX_JSONL_RECORDS}) exceeded`, results);
      }
      try {
        results.push(JSON.parse(pending) as T);
      } catch {
        throw new JsonlLimitError(path, "unterminated final JSON object", results);
      }
    }
  }
  return results;
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

/**
 * Placeholder segment for `SessionParser.restoreRoots`: matches exactly one
 * path segment (e.g. an agent id). It contains a NUL byte, so no real path
 * segment can ever equal it.
 */
export const ANY_PATH_SEGMENT = "\u0000*";

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
  maxFiles = DEFAULT_MAX_FILES
): Promise<string[]> {
  const results: string[] = [];

  const walk = async (current: string, depth: number): Promise<void> => {
    if (depth <= 0) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Missing provider roots mean "not installed"; nested ENOENT is a
      // benign concurrent removal. Every other failure is an incomplete scan
      // and must reach the provider warning/sealing guard.
      if (code === "ENOENT") return;
      throw error;
    }

    for (const entry of entries) {
      if (entry.isDirectory() && !entry.isSymbolicLink()) {
        await walk(join(current, entry.name), depth - 1);
      } else if (entry.isFile() && !entry.isSymbolicLink() && predicate(entry.name)) {
        results.push(join(current, entry.name));
        if (results.length > maxFiles) {
          throw new Error(`File discovery limit (${maxFiles}) exceeded under ${dir}`);
        }
      }
      // Symlinks and special files are deliberately outside provider roots.
    }
  };

  await walk(dir, maxDepth);
  return results;
}

/** Read and parse JSON safely. */
export async function readJsonFile<T>(path: string): Promise<T> {
  const fileStat = await stat(path);
  if (fileStat.size > MAX_JSONL_INPUT_BYTES) {
    throw new Error(`JSON input limit (${MAX_JSONL_INPUT_BYTES} bytes) exceeded for ${path}`);
  }
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

/** Read JSONL file and parse each line. Malformed input is incomplete. A bounded
 *  parser fault returns completed records and calls `onError`; callers must
 *  propagate that incomplete status before any authoritative sealing. */
export async function readJsonlFile<T>(
  path: string,
  onError?: (error: unknown) => void,
  onSnapshot?: (snapshot: { mtimeMs: number; sizeBytes: number }) => void
): Promise<T[]> {
  let fd: FileHandle | null = null;
  try {
    fd = await open(path, "r");
    const fileStat = await fd.stat();
    onSnapshot?.({ mtimeMs: fileStat.mtimeMs, sizeBytes: fileStat.size });
    if (fileStat.size > MAX_JSONL_INPUT_BYTES) {
      throw new JsonlLimitError(
        path,
        `snapshot limit (${MAX_JSONL_INPUT_BYTES} bytes) exceeded`,
        []
      );
    }
    if (fileStat.size === 0) return [];
    return await streamJsonlFile<T>(fd, path, 0, fileStat.size - 1);
  } catch (error) {
    if (!onError) throw error;
    onError(error);
    return error instanceof JsonlLimitError ? (error.partialResults as T[]) : [];
  } finally {
    if (fd) {
      try {
        await fd.close();
      } catch {
        /* close failure is best-effort */
      }
    }
  }
}

/** Minimal read-only SQLite handle shared by the two available drivers. */
export interface ReadonlySqlite {
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  close(): void;
}

/**
 * Wait briefly for a writer's lock instead of failing at once. Every driver
 * defaults to a 0 ms busy timeout, so a scan that lands while the owning app
 * (OpenCode, Cursor, …) holds a rollback-journal lock throws "database is
 * locked" and the parser silently reports nothing for that pass. Short on
 * purpose: these drivers are synchronous and block the daemon's event loop.
 */
function withBusyTimeout(db: ReadonlySqlite): ReadonlySqlite {
  try {
    db.get("PRAGMA busy_timeout = 1000");
  } catch {
    // Best effort — a driver that rejects the pragma still reads fine.
  }
  return db;
}

/**
 * Opens a SQLite database read-only, picking the right driver for the
 * runtime: `bun:sqlite` under Bun; under Node the built-in `node:sqlite`
 * (Node ≥ 22.5), then `better-sqlite3`.
 *
 * better-sqlite3's native N-API bindings are not supported under Bun
 * (https://github.com/oven-sh/bun/issues/4290 — `dlopen` refuses to load
 * them, Bun's own error message points at `bun:sqlite` instead), so a
 * parser that only tries `better-sqlite3` silently returns zero records on
 * every Bun install, including this project's own dev/CLI runtime.
 *
 * Under Node, better-sqlite3 is not a dependency of the published package —
 * it only resolves from packages/core in this repo — so the daemon and every
 * npm install got `null` here and all SQLite-backed parsers came back empty.
 * `node:sqlite` needs no install; better-sqlite3 remains the fallback for
 * older Node. With none available the result is `null`, not a crash.
 */
export async function openReadonlySqlite(path: string): Promise<ReadonlySqlite> {
  if (typeof (globalThis as { Bun?: unknown }).Bun !== "undefined") {
    try {
      // @ts-expect-error — bun:sqlite only resolves under the Bun runtime
      const { Database } = await import("bun:sqlite");
      const db = new Database(path, { readonly: true });
      return withBusyTimeout({
        get: (sql, ...params) => db.query(sql).get(...params) as never,
        all: (sql, ...params) => db.query(sql).all(...params) as never,
        close: () => db.close(),
      });
    } catch (error) {
      throw new Error(
        `Unable to open SQLite database ${path}: ${error instanceof Error ? error.message : error}`
      );
    }
  }
  try {
    // Specifier in a variable so bundlers and older type libs leave it alone.
    const builtin = "node:sqlite";
    const { DatabaseSync } = (await import(builtin)) as {
      DatabaseSync: new (
        path: string,
        opts: { readOnly: boolean }
      ) => {
        prepare(sql: string): { get(...p: unknown[]): unknown; all(...p: unknown[]): unknown[] };
        close(): void;
      };
    };
    const db = new DatabaseSync(path, { readOnly: true });
    return withBusyTimeout({
      get: (sql, ...params) => db.prepare(sql).get(...params) as never,
      all: (sql, ...params) => db.prepare(sql).all(...params) as never,
      close: () => db.close(),
    });
  } catch {
    // Node < 22.5 — fall through to better-sqlite3.
  }
  try {
    // @ts-expect-error — better-sqlite3 is an optional dependency
    const { default: Database } = await import("better-sqlite3");
    const db = new Database(path, { readonly: true });
    return withBusyTimeout({
      get: (sql, ...params) => db.prepare(sql).get(...params),
      all: (sql, ...params) => db.prepare(sql).all(...params),
      close: () => db.close(),
    });
  } catch (error) {
    throw new Error(
      `Unable to open SQLite database ${path}: ${error instanceof Error ? error.message : error}`
    );
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
        outputTokens: normalizedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: directMetric,
        notes: [
          "OpenAI-style total input is normalized to uncached input + cache read; output is normalized to visible output + reasoning.",
        ],
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
      return withMetrics(baseProvenance("tool_sqlite"), {
        inputTokens: notExposedMetric,
        cacheReadTokens: notExposedMetric,
        cacheWriteTokens: notExposedMetric,
        reasoningTokens: notExposedMetric,
        cost: notExposedMetric,
        notes: [
          "Sourced from Codex's local SQLite state (threads.tokens_used) as a fallback for threads whose rollout JSONL has no token_count events — Codex Desktop / VS Code-extension sessions confirmed to never emit them locally. tokens_used is one cumulative lump total with no input/output/cache split, so the full delta is placed in outputTokens as a TOTAL, not a real output count; cost is left unexposed rather than guessing an input/output ratio to price it.",
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
  const record: TokenRecord = {
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
  record.model = sanitizeDataLabel(record.model, 256) || "unknown";
  record.project = sanitizeDataLabel(record.project, 512) || "unknown";
  if (record.cwd) record.cwd = sanitizeDataLabel(record.cwd, 1024);
  if (record.toolCalls) {
    record.toolCalls = record.toolCalls
      .map((tool) => sanitizeDataLabel(tool, 256))
      .filter((tool) => tool.length > 0);
  }
  return record;
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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

/** Check if a directory exists. */
export async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}
