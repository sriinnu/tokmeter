/**
 * @sriinnu/tokmeter-core — Append-aware disk-persisted parsed-record cache.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  ensurePrivateDirectory,
  ensurePrivateFile,
  writePrivateFile,
} from "../../private-files.js";
import type { TokenRecord } from "../../types.js";

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

const CACHE_GC_INTERVAL_MS = 5 * 60 * 1000;
const CACHE_SAVE_MIN_INTERVAL_MS = 60_000;

interface RecordCacheStore {
  cacheDir: string;
  cacheFile: string;
  entries: Map<string, RecordCacheEntry>;
  stats: {
    files: number;
    records: number;
    cacheHits: number;
    cacheMisses: number;
    appends: number;
  };
  createdAt: string | null;
  koshaMtime: number;
  overridesMtime: number;
  /** Paths observed since the last GC sweep. Cleared each sweep so deleted
   *  files eventually lose immunity and are evicted on a future sweep. */
  touchedPaths: Set<string>;
  lastGcAtMs: number;
  dirty: boolean;
  lastSavedAtMs: number;
}

const recordCachesByHome = new Map<string, RecordCacheStore>();

function cacheHomeKey(homeDir?: string): string {
  return resolve(homeDir || homedir());
}

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
 * 11 — Codex per-response token_usage_record support and unknown model fallback.
 * 12 — Preserve explicit tool-reported zero cost instead of repricing it.
 * 13 — claude-code parser dedups on message.id+requestId (one record per API
 *      response). Timestamp-keyed dedup counted a turn once per content-block
 *      line — a parallel-tool-call turn N times. Cached records are inflated;
 *      rebuild.
 * 14 — claude-code records carry cacheWrite1hTokens (the 1h-TTL share of cache
 *      writes, billed at 2× input vs 1.25× for 5m). Cached records lack the
 *      field and were priced as if every write were 5m; rebuild.
 * 15 — claude-code dedup keeps the MAX usage across a response's lines, not
 *      the first: subagent transcripts open with placeholder usage from
 *      message_start and only the last line carries real output tokens.
 *      v13/v14 caches hold first-line values for subagent turns; rebuild.
 * 17 — opencode/kilo-cli read the current `message.data` JSON schema (the
 *      flat `messages` query threw, so every DB-era message was dropped) and
 *      opencode merges legacy JSON with the DB instead of either-or.
 * 18 — opencode free-tier ($0, `-free`/`:free`) records carry cost provenance
 *      "direct", so they render $0.00 instead of "Unavailable". Same for
 *      custom-source lines served by a local runtime (Ollama, LM Studio, …).
 * 19 — codex reads compressed (.jsonl.zst) and archived rollouts, which it
 *      had skipped entirely; also covers #135's chitragupta provider label.
 * 20/21 — display hardening and bounded streaming parser revisions.
 * 22 — Claude append scans cache the exact descriptor snapshot boundary;
 *      older entries can double-count bytes appended during a scan.
 * 23 — bounded JSONL snapshots and cached-record totals prevent append-mode
 *      sessions from bypassing the per-read memory limits.
 * 24 — claude-code clamps the 1h cache-write share to its total, streams
 *      sessions of any size line by line (cached offset = last consumed line,
 *      so a line caught mid-write is re-read), skips oversized lines instead
 *      of refusing the file, and folds a fork-subagent's copy of its parent's
 *      message into the original. v23 caches can hold 1h > total, nothing for
 *      sessions past 128 MiB, and fork duplicates; rebuild.
 * 25 — vscode-copilot replays *.jsonl chat sessions as mutation logs and reads
 *      them under workspaceStorage too. v24 threw on any multi-line session
 *      (failing the whole provider) and never saw workspace *.jsonl sessions.
 * 26 — a record with no usable timestamp is marked timestampInferred and
 *      dated by its file (settleInferredTimes), not the scan's clock. v25
 *      caches hold such records at the time they were first scanned; rebuild.
 * 27 — project names: eval trial folders and per-run temp folders get a
 *      stable name, fixed at parse time; v26 caches hold `1`, `2`, `3`.
 * 28 — Cursor's local database is read as one record per counted bubble, with
 *      the model from its request's user bubble. v26 gave every record in a
 *      conversation the first model seen in it.
 * 29 — OpenCode's session v2 table `session_message` is read too. v28 read
 *      only `message`, which OpenCode stopped writing, so newer messages
 *      (e.g. every Gemini 4 call) were missing.
 * 30 — Antigravity 2.x conversation databases are read: one record per API
 *      call with tokens and model. v29 read only the state.vscdb summaries,
 *      which carry no usage, so every Antigravity call counted 0.
 * 31 — project names: a Claude Code worktree (`<repo>/.claude/worktrees/<n>`)
 *      names as its repo, fixed at parse time; v30 caches hold `agent-a67d…`.
 * 32 — direct-cost provenance: `cline` and `custom-source` record
 *      `usage.cost = "direct"` when carrying a positive tool-reported cost so
 *      repricing never resets those records to $0.
 * 33 — parser accuracy & coverage fixes: Gemini CLI `.jsonl` sessions, model IDs,
 *      and project extraction; Cursor WAL invalidation and quoted CSV fields;
 *      Codex subagent `cwd`/`project` preservation across replayed parent meta;
 *      Antigravity 64-bit proto fields.
 */
const CACHE_VERSION = 33;

function loadRecordCache(homeDir?: string): RecordCacheStore {
  const key = cacheHomeKey(homeDir);
  const existing = recordCachesByHome.get(key);
  if (existing) return existing;
  const cacheDir = join(key, ".cache", "tokmeter");
  const cacheFile = join(cacheDir, "scan-cache.json");
  const store: RecordCacheStore = {
    cacheDir,
    cacheFile,
    entries: new Map(),
    stats: { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 },
    createdAt: null,
    koshaMtime: 0,
    overridesMtime: 0,
    touchedPaths: new Set(),
    lastGcAtMs: 0,
    dirty: false,
    lastSavedAtMs: 0,
  };
  recordCachesByHome.set(key, store);
  try {
    ensurePrivateDirectory(cacheDir);
    ensurePrivateFile(cacheFile);
    if (existsSync(cacheFile)) {
      const data = JSON.parse(readFileSync(cacheFile, "utf-8")) as CacheFile;
      // Reject old cache versions — fall through to empty map so all files
      // get re-parsed with the current parser semantics.
      if (data.version !== CACHE_VERSION) {
        // Flag the rebuild so a long re-parse on first scan after upgrade
        // doesn't look like a hung menubar. stderr keeps it out of stdout
        // (which CLI consumers might be piping into jq).
        console.warn(
          `[tokmeter] scan-cache schema bumped ${data.version} → ${CACHE_VERSION}, rebuilding from JSONL on next scan. One-time cost.`
        );
        store.createdAt = new Date().toISOString();
        return store;
      }
      store.createdAt = data.createdAt;
      store.koshaMtime = data.koshaMtime ?? 0;
      store.overridesMtime = data.overridesMtime ?? 0;
      for (const [k, v] of Object.entries(data.files)) {
        store.entries.set(k, v);
      }
    }
  } catch {}
  return store;
}

/**
 * Throttled stale-path eviction. A long-lived daemon would otherwise carry
 * cache entries for every file ever scanned in its lifetime, even ones the
 * user has since deleted via `tokmeter cleanup` or that aged out of provider
 * retention. We sweep at most every {@link CACHE_GC_INTERVAL_MS} so a tight
 * scan loop (every 12 s) doesn't fan out N stats per tick.
 *
 * Eviction rule: a path is dropped only if (a) it wasn't observed live since
 * the previous sweep AND (b) it does not exist on disk. `touchedPaths` resets
 * at the end of each sweep so files deleted after an earlier scan do not stay
 * pinned in RAM forever.
 */
function gcStalePathsIfDue(store: RecordCacheStore): void {
  const nowMs = Date.now();
  if (nowMs - store.lastGcAtMs < CACHE_GC_INTERVAL_MS) return;
  store.lastGcAtMs = nowMs;
  for (const key of [...store.entries.keys()]) {
    if (store.touchedPaths.has(key)) continue;
    if (!existsSync(key)) {
      store.entries.delete(key);
      store.dirty = true;
    }
  }
  store.touchedPaths.clear();
}

function saveRecordCacheStore(
  store: RecordCacheStore,
  options?: { force?: boolean; minIntervalMs?: number }
): void {
  try {
    gcStalePathsIfDue(store);
    if (!store.dirty) return;
    const minIntervalMs = options?.minIntervalMs ?? CACHE_SAVE_MIN_INTERVAL_MS;
    if (
      !options?.force &&
      store.lastSavedAtMs > 0 &&
      Date.now() - store.lastSavedAtMs < minIntervalMs
    ) {
      return;
    }
    ensurePrivateDirectory(store.cacheDir);
    const data: CacheFile = {
      version: CACHE_VERSION,
      createdAt: store.createdAt || new Date().toISOString(),
      lastScanAt: new Date().toISOString(),
      koshaMtime: store.koshaMtime,
      overridesMtime: store.overridesMtime,
      stats: {
        ...store.stats,
        files: store.entries.size,
        records: [...store.entries.values()].reduce((s, e) => s + e.records.length, 0),
      },
      files: Object.fromEntries(store.entries),
    };
    // Atomic write: tmp file + rename prevents corruption from concurrent processes
    writePrivateFile(store.cacheFile, JSON.stringify(data));
    store.dirty = false;
    store.lastSavedAtMs = Date.now();
  } catch {}
}

/** Kosha registry mtime associated with the currently-loaded cache, or 0. */
export function getCachedKoshaMtime(homeDir?: string): number {
  return loadRecordCache(homeDir).koshaMtime;
}

/** Record the kosha registry mtime that cached `cost` fields were priced against. */
export function setCachedKoshaMtime(mtimeMs: number, homeDir?: string): void {
  const store = loadRecordCache(homeDir);
  if (store.koshaMtime !== mtimeMs) {
    store.koshaMtime = mtimeMs;
    store.dirty = true;
  }
}

/** Pricing-overrides mtime associated with the currently-loaded cache, or 0. */
export function getCachedOverridesMtime(homeDir?: string): number {
  return loadRecordCache(homeDir).overridesMtime;
}

/** Record the pricing-overrides mtime that today's cached costs were priced against. */
export function setCachedOverridesMtime(mtimeMs: number, homeDir?: string): void {
  const store = loadRecordCache(homeDir);
  if (store.overridesMtime !== mtimeMs) {
    store.overridesMtime = mtimeMs;
    store.dirty = true;
  }
}

/** Mark the record cache for `homeDir` dirty after in-place cost enrichment. */
export function markRecordCacheDirty(homeDir?: string): void {
  loadRecordCache(homeDir).dirty = true;
}

/**
 * Records last parsed for a file, straight from the in-memory cache — no stat,
 * no freshness check, never touches disk. For hot-path readers (a statusline
 * tick) that want "everything the daemon has parsed from this transcript"
 * and can tolerate the tail being as stale as the daemon's refresh cadence.
 */
export function peekCachedRecords(path: string, homeDir?: string): TokenRecord[] | null {
  const entry = loadRecordCache(homeDir).entries.get(path);
  return entry ? [...entry.records] : null;
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
export async function getCachedRecords(
  path: string,
  homeDir?: string
): Promise<
  | { hit: true; records: TokenRecord[] }
  | {
      hit: false;
      appendOffset: number;
      cachedRecords: TokenRecord[];
      statHint?: { mtimeMs: number; sizeBytes: number };
    }
> {
  const store = loadRecordCache(homeDir);
  // Record that we've observed this path live — keeps the GC sweep from
  // evicting files we're actively scanning even if a transient stat fails.
  store.touchedPaths.add(path);
  const entry = store.entries.get(path);
  if (!entry) {
    store.stats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [] };
  }
  try {
    const s = await stat(path);
    const statHint = { mtimeMs: s.mtimeMs, sizeBytes: s.size };
    // Exact hit: nothing changed
    if (s.mtimeMs === entry.mtimeMs && s.size === entry.sizeBytes) {
      store.stats.cacheHits++;
      return { hit: true, records: [...entry.records] };
    }
    // File grew: append-only parse from where we left off
    if (s.size > entry.sizeBytes) {
      store.stats.appends++;
      return {
        hit: false,
        appendOffset: entry.sizeBytes,
        cachedRecords: [...entry.records],
        statHint,
      };
    }
    // File shrunk or rewritten: full re-parse
    store.stats.cacheMisses++;
    return { hit: false, appendOffset: 0, cachedRecords: [], statHint };
  } catch {
    store.stats.cacheMisses++;
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
  statHint?: { mtimeMs: number; sizeBytes: number },
  homeDir?: string
): Promise<void> {
  const store = loadRecordCache(homeDir);
  store.touchedPaths.add(path);
  const snapshot = [...records];
  try {
    if (statHint) {
      store.entries.set(path, {
        mtimeMs: statHint.mtimeMs,
        sizeBytes: statHint.sizeBytes,
        records: snapshot,
      });
      store.dirty = true;
      return;
    }
    const s = await stat(path);
    store.entries.set(path, { mtimeMs: s.mtimeMs, sizeBytes: s.size, records: snapshot });
    store.dirty = true;
  } catch {}
}

/** Flush the in-memory record cache to disk when dirty (throttled unless forced). */
export function saveRecordCacheToDisk(
  homeDir?: string,
  options?: { force?: boolean; minIntervalMs?: number }
): void {
  const store = recordCachesByHome.get(cacheHomeKey(homeDir));
  if (!store) return;
  saveRecordCacheStore(store, options);
}

/** Force-flush every dirty in-memory record cache across all home dirs (for shutdown). */
export function flushAllRecordCaches(): void {
  for (const store of recordCachesByHome.values()) {
    saveRecordCacheStore(store, { force: true });
  }
}

function invalidateInStore(store: RecordCacheStore, paths: string[]): boolean {
  let removed = false;
  for (const p of paths) {
    if (store.entries.delete(p)) removed = true;

    const directoryPrefix = p.endsWith("/") || p.endsWith("\\") ? p : `${p}/`;
    const windowsDirectoryPrefix = p.endsWith("\\") || p.endsWith("/") ? p : `${p}\\`;

    for (const key of store.entries.keys()) {
      if (key.startsWith(directoryPrefix) || key.startsWith(windowsDirectoryPrefix)) {
        store.entries.delete(key);
        removed = true;
      }
    }
  }
  return removed;
}

/** Remove specific entries from both in-memory and disk cache (used after cleanup). */
export function invalidateRecordCache(paths: string[], homeDir?: string): void {
  const stores =
    homeDir !== undefined ? [loadRecordCache(homeDir)] : [...recordCachesByHome.values()];
  if (stores.length === 0 && homeDir === undefined) {
    stores.push(loadRecordCache(undefined));
  }
  for (const store of stores) {
    if (invalidateInStore(store, paths)) {
      store.dirty = true;
      saveRecordCacheStore(store, { force: true });
    }
  }
}

/** Clear the entire record cache, forcing a full rescan. */
export function clearRecordCache(homeDir?: string): void {
  const store = loadRecordCache(homeDir);
  store.entries.clear();
  store.stats = { files: 0, records: 0, cacheHits: 0, cacheMisses: 0, appends: 0 };
  store.touchedPaths.clear();
  store.lastGcAtMs = 0;
  store.dirty = false;
  store.lastSavedAtMs = 0;
  try {
    if (existsSync(store.cacheFile)) {
      unlinkSync(store.cacheFile);
    }
  } catch {}
}
