/**
 * @sriinnu/tokmeter-core — Muse (Meta's coding agent) session parser.
 *
 * Reads from ~/.local/share/muse/sessions/YYYY/MM/DD/<session-id>/session.jsonl
 *
 * Muse writes an event-sourced log: one flat JSON record per line, each with a
 * stable `id`, a microsecond `recorded_at`, a `payload_type`, and a `payload`.
 * Token usage lives on the `event.kind === "model_completed"` records:
 *
 *   payload.event = {
 *     kind: "model_completed",
 *     usage: { input_tokens, output_tokens, cached_tokens,
 *              cache_read_tokens, cache_write_tokens, reasoning_tokens },
 *     model: "muse-spark-1.3"
 *   }
 *
 * One `model_completed` record == one API response, so the record's own `id`
 * is the dedup key. The same usage is ALSO echoed on `goal_usage_attribution`
 * / `usage_family:"provider"` records — those are a parallel attribution view
 * of the same spend, so we count ONLY `model_completed` or we double-bill.
 *
 * Muse reports OpenAI-style: `input_tokens` is the FULL prompt and INCLUDES
 * `cache_read_tokens` (mirrored as `cached_tokens`). We subtract the cached
 * portion so inputTokens = uncached only, matching Anthropic semantics and the
 * gemini parser, so the cost calculator never charges cached tokens at the
 * full input rate.
 */

import type { Dirent } from "node:fs";
import { lstat, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { localDateKey } from "../date-utils.js";
import { sanitizeDataLabel } from "../display-safety.js";
import { canonicalizeProjectName } from "../project-name.js";
import type { ScanFilterOptions, SessionParser, TokenRecord } from "../types.js";
import { mapWithConcurrency } from "./utils/fs-helpers.js";
import {
  createRecord,
  expandHome,
  filterFilesByMtime,
  getCachedRecords,
  readJsonlFile,
  setCachedRecords,
} from "./utils.js";

const DAY_LISTING_CACHE_MAX = 2000;
const DAY_DIR_STAT_CONCURRENCY = 32;
const RECENT_DAY_CACHE_GUARD_MS = 60_000;
const dayListingCache = new Map<string, { mtimeMs: number; sessionFiles: string[] }>();

/** Reset Muse's in-memory historical day-directory cache (intended for tests). */
export function clearMuseDayListingCache(): void {
  dayListingCache.clear();
}

function isMissingPathError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function cacheDayListing(dayPath: string, mtimeMs: number, sessionFiles: string[]): void {
  if (dayListingCache.has(dayPath)) dayListingCache.delete(dayPath);
  dayListingCache.set(dayPath, { mtimeMs, sessionFiles });
  if (dayListingCache.size > DAY_LISTING_CACHE_MAX) {
    const oldest = dayListingCache.keys().next().value;
    if (oldest !== undefined) dayListingCache.delete(oldest);
  }
}

async function readVisibleDirs(dir: string): Promise<Dirent[] | null> {
  try {
    return (await readdir(dir, { withFileTypes: true })).filter(
      (entry) => !entry.name.startsWith(".") && entry.name !== "approval-review"
    );
  } catch (error) {
    if (isMissingPathError(error)) return null;
    throw error;
  }
}

async function listDaySessionFiles(
  dayPath: string,
  dayDateKey: string,
  todayKey: string,
  nowMs: number
): Promise<string[]> {
  let s: Awaited<ReturnType<typeof lstat>>;
  try {
    s = await lstat(dayPath);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
  if (!s.isDirectory()) return [];

  const cacheEligible = dayDateKey < todayKey && nowMs - s.mtimeMs >= RECENT_DAY_CACHE_GUARD_MS;
  if (cacheEligible) {
    const cached = dayListingCache.get(dayPath);
    if (cached && cached.mtimeMs === s.mtimeMs) {
      dayListingCache.delete(dayPath);
      dayListingCache.set(dayPath, cached);
      return cached.sessionFiles;
    }
  }

  const entries = await readVisibleDirs(dayPath);
  if (!entries) return [];
  const candidates: Array<{ filePath: string; fromSubdir: boolean }> = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      candidates.push({ filePath: join(dayPath, entry.name, "session.jsonl"), fromSubdir: true });
    } else if (entry.isFile() && entry.name === "session.jsonl") {
      candidates.push({ filePath: join(dayPath, entry.name), fromSubdir: false });
    }
  }

  let hasIncompleteSubdir = false;
  const existing = (
    await mapWithConcurrency(candidates, DAY_DIR_STAT_CONCURRENCY, async (candidate) => {
      try {
        const st = await lstat(candidate.filePath);
        if (st.isFile()) return candidate.filePath;
        if (candidate.fromSubdir) hasIncompleteSubdir = true;
        return null;
      } catch (error) {
        if (isMissingPathError(error)) {
          if (candidate.fromSubdir) hasIncompleteSubdir = true;
          return null;
        }
        throw error;
      }
    })
  ).filter((filePath): filePath is string => filePath !== null);

  if (cacheEligible && !hasIncompleteSubdir) {
    cacheDayListing(dayPath, s.mtimeMs, existing);
  }
  return existing;
}

/**
 * Discover `session.jsonl` files under Muse's sessions tree while skipping
 * hidden maintenance views (`.msp-view-*`) and per-session `approval-review/`
 * / SQLite sidecar directories.
 */
async function discoverMuseSessionFiles(
  sessionsDir: string,
  modifiedSinceMs?: number
): Promise<string[]> {
  const topEntries = await readVisibleDirs(sessionsDir);
  if (!topEntries) return [];

  const nowMs = Date.now();
  const todayKey = localDateKey(nowMs);
  const sessionFiles: string[] = [];
  const walkFallback = async (dir: string, depth: number): Promise<void> => {
    if (depth <= 0) return;
    const entries = await readVisibleDirs(dir);
    if (!entries) return;
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walkFallback(fullPath, depth - 1);
      } else if (entry.isFile() && entry.name === "session.jsonl") {
        sessionFiles.push(fullPath);
      }
    }
  };

  for (const yearEntry of topEntries) {
    const yearPath = join(sessionsDir, yearEntry.name);
    if (yearEntry.isDirectory() && /^\d{4}$/.test(yearEntry.name)) {
      const monthEntries = await readVisibleDirs(yearPath);
      if (!monthEntries) continue;
      for (const monthEntry of monthEntries) {
        const monthPath = join(yearPath, monthEntry.name);
        if (monthEntry.isDirectory() && /^\d{2}$/.test(monthEntry.name)) {
          const dayEntries = await readVisibleDirs(monthPath);
          if (!dayEntries) continue;
          const dayDirs = dayEntries.filter((d) => d.isDirectory() && /^\d{2}$/.test(d.name));
          const nonDayEntries = dayEntries.filter(
            (d) => !(d.isDirectory() && /^\d{2}$/.test(d.name))
          );
          const dayBatches = await mapWithConcurrency(dayDirs, 16, (dayEntry) =>
            listDaySessionFiles(
              join(monthPath, dayEntry.name),
              `${yearEntry.name}-${monthEntry.name}-${dayEntry.name}`,
              todayKey,
              nowMs
            )
          );
          for (const batch of dayBatches) sessionFiles.push(...batch);
          for (const extra of nonDayEntries) {
            const extraPath = join(monthPath, extra.name);
            if (extra.isDirectory()) await walkFallback(extraPath, 3);
            else if (extra.isFile() && extra.name === "session.jsonl") sessionFiles.push(extraPath);
          }
        } else if (monthEntry.isDirectory()) {
          await walkFallback(monthPath, 4);
        } else if (monthEntry.isFile() && monthEntry.name === "session.jsonl") {
          sessionFiles.push(monthPath);
        }
      }
    } else if (yearEntry.isDirectory()) {
      await walkFallback(yearPath, 5);
    } else if (yearEntry.isFile() && yearEntry.name === "session.jsonl") {
      sessionFiles.push(yearPath);
    }
  }

  return modifiedSinceMs !== undefined
    ? filterFilesByMtime(sessionFiles, modifiedSinceMs)
    : sessionFiles;
}

interface MuseUsage {
  input_tokens?: number;
  output_tokens?: number;
  cached_tokens?: number;
  cache_read_tokens?: number;
  cache_write_tokens?: number;
  reasoning_tokens?: number;
}

interface MuseRecord {
  id?: string;
  recorded_at?: number; // microseconds since epoch
  payload_type?: string;
  payload?: {
    kind?: string;
    event?: {
      kind?: string;
      usage?: MuseUsage;
      model?: string;
    };
    record?: {
      workspace_root?: string;
    };
  };
}

export class MuseParser implements SessionParser {
  readonly providerId = "muse" as const;

  /** Directories this parser reads; restore validates archive paths against them. */
  sessionRoots(homeDir: string): string[] {
    return [expandHome("~/.local/share/muse/sessions", homeDir)];
  }

  async scan(homeDir: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const out: TokenRecord[] = [];
    await this.scanStreaming(homeDir, opts, (records) => {
      out.push(...records);
    });
    return out;
  }

  /**
   * The daemon's today refresh runs every ~12 s with `modifiedSinceMs` set to
   * the start of today, and the relay rebuild sets it to its window's start.
   * Ignoring it re-parsed every Muse session on each refresh: 799 MB across
   * 74k files, 9–12 s a refresh on the machine that showed it. Unchanged
   * files reuse their records from the per-file cache (mtime + size, taken
   * before the read so a write mid-parse is read again next time).
   */
  async scanStreaming(
    homeDir: string,
    opts: ScanFilterOptions | undefined,
    onFile: (records: TokenRecord[]) => void | Promise<void>
  ): Promise<void> {
    const [sessionsDir] = this.sessionRoots(homeDir);
    const files = await discoverMuseSessionFiles(sessionsDir, opts?.modifiedSinceMs);

    for (const file of files) {
      try {
        const cached = await getCachedRecords(file, homeDir);
        let records: TokenRecord[];
        if (cached.hit) {
          records = cached.records;
        } else {
          let before: { mtimeMs: number; sizeBytes: number } | undefined;
          try {
            const s = await stat(file);
            before = { mtimeMs: s.mtimeMs, sizeBytes: s.size };
          } catch {}
          records = await this.parseFile(file, opts);
          if (before) await setCachedRecords(file, records, before, homeDir);
        }
        if (records.length > 0) await onFile(records);
      } catch (error) {
        opts?.onWarning?.(
          `muse: failed read of ${file}: ${error instanceof Error ? error.message : error}`,
          { file }
        );
      }
    }
  }

  private async parseFile(file: string, opts?: ScanFilterOptions): Promise<TokenRecord[]> {
    const lines = await readJsonlFile<MuseRecord>(file, (err) =>
      opts?.onWarning?.(
        `muse: failed read of ${file}: ${err instanceof Error ? err.message : err}`,
        { file }
      )
    );
    const records: TokenRecord[] = [];
    const seenIds = new Set<string>();
    let workspaceRoot: string | undefined;

    for (const rec of lines) {
      // Capture the session's workspace once — it arrives on a
      // runtime.session.metadata record, not on the usage records.
      if (!workspaceRoot && rec.payload?.record?.workspace_root) {
        workspaceRoot = rec.payload.record.workspace_root;
      }

      const event = rec.payload?.event;
      if (event?.kind !== "model_completed" || !event.usage) continue;

      // Dedup on the record id — one model_completed == one API response.
      const id = rec.id;
      if (id) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }

      const u = event.usage;
      const totalInput = u.input_tokens ?? 0;
      // `cached_tokens` mirrors `cache_read_tokens` in observed data, but take
      // the max rather than `??` so an explicit `cache_read_tokens: 0` alongside
      // a populated `cached_tokens` still strips the cached portion (otherwise
      // those tokens get billed at the full input rate).
      const cacheRead = Math.max(u.cache_read_tokens ?? 0, u.cached_tokens ?? 0);
      // input_tokens includes the cached portion (OpenAI-style) — strip it.
      const inputTokens = Math.max(0, totalInput - cacheRead);

      const ts =
        typeof rec.recorded_at === "number" && Number.isFinite(rec.recorded_at)
          ? Math.round(rec.recorded_at / 1000)
          : undefined;

      records.push(
        createRecord({
          timestamp: ts,
          provider: "muse",
          model: event.model || "muse-spark-1.3",
          project: workspaceRoot ? canonicalizeProjectName(workspaceRoot, "muse") : "muse",
          cwd: workspaceRoot,
          sourceFile: file,
          apiCallId: id,
          inputTokens,
          outputTokens: u.output_tokens ?? 0,
          cacheReadTokens: cacheRead,
          cacheWriteTokens: u.cache_write_tokens ?? 0,
          reasoningTokens: u.reasoning_tokens ?? 0,
        })
      );
    }

    // workspace_root can appear AFTER the first model_completed; backfill the
    // project for any records emitted before we saw it.
    if (workspaceRoot) {
      const project = canonicalizeProjectName(workspaceRoot, "muse");
      for (const r of records) {
        if (r.project === "muse") {
          r.project = sanitizeDataLabel(project) || "muse";
          r.cwd = sanitizeDataLabel(workspaceRoot, 4096);
        }
      }
    }

    return records;
  }
}
