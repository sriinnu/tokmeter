/**
 * @sriinnu/tokmeter-core — Session file discovery, path helpers, and concurrency control.
 */

import type { Dirent } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { loadConfig } from "../../config-service.js";
import type { ProviderId } from "../../types.js";

/** Default maximum number of files returned by findFiles. */
const DEFAULT_MAX_FILES = 10_000;

/**
 * Placeholder segment for `SessionParser.restoreRoots`: matches exactly one
 * path segment (e.g. an agent id). It contains a NUL byte, so no real path
 * segment can ever equal it.
 */
export const ANY_PATH_SEGMENT = "\u0000*";

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
