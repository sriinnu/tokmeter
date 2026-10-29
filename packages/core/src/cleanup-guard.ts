/**
 * @sriinnu/tokmeter-core — cleanup containment checks.
 *
 * Cleaners derive what to delete from record `sourceFile`s, which come from
 * file names and index entries on disk. A strange name must never widen a
 * delete beyond one session, so CleanupService checks every resolved target
 * here before preview returns it and again right before execute deletes:
 *
 *   - a target may never be relative, the filesystem root, the home dir, or
 *     an ancestor of (or the same directory as) a known session root —
 *     `rm -rf` on any of those would take every session with it;
 *   - a shared multi-session app database (Cursor's state.vscdb, …) is never
 *     deleted as a whole file; it is reported as not removable instead.
 */

import { closeSync, lstatSync, openSync, readSync } from "node:fs";
import { extname, isAbsolute, join, resolve } from "node:path";
import { claudeSessionSideDirs } from "./cleaners/claude-code.js";
import { ALL_PARSERS } from "./parsers/index.js";
import { isWithin } from "./restore-guard.js";
import type { CleanupTarget } from "./types.js";

/** Thrown when a resolved cleanup target would delete more than a session. */
export class UnsafeCleanupTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeCleanupTargetError";
  }
}

/** Why a matched source file is left in place. */
export const SHARED_DATABASE_REASON = "not removable by cleanup (shared app database)";

const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
const DATABASE_EXTENSIONS = new Set([".db", ".sqlite", ".sqlite3", ".vscdb"]);

/**
 * True when `path` is a database file that holds many sessions (and usually
 * unrelated app state). Detected by extension or by the SQLite header, so a
 * WAL-mode or currently locked database is still recognised.
 */
export function isSharedDatabaseFile(path: string): boolean {
  if (DATABASE_EXTENSIONS.has(extname(path).toLowerCase())) return true;
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = Buffer.alloc(SQLITE_MAGIC.length);
    const read = readSync(fd, head, 0, head.length, 0);
    return read === SQLITE_MAGIC.length && head.equals(SQLITE_MAGIC);
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Directories no cleanup target may equal or contain. */
export function protectedCleanupPaths(homeDir: string): string[] {
  const claudeDir = join(homeDir, ".claude");
  const paths = new Set<string>([
    resolve(homeDir),
    resolve(claudeDir),
    resolve(claudeDir, "projects"),
  ]);
  for (const dir of Object.values(claudeSessionSideDirs(homeDir))) paths.add(resolve(dir));
  for (const parser of ALL_PARSERS) {
    for (const root of parser.sessionRoots?.(homeDir) ?? []) {
      if (root) paths.add(resolve(root));
    }
  }
  return [...paths];
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Throw {@link UnsafeCleanupTargetError} when any file/directory target is
 * relative, or equals or contains the home dir, ~/.claude, ~/.claude/projects,
 * a Claude Code side dir, or a parser session root. Nothing is deleted when
 * this throws. A file target may equal a session root only when that root is
 * itself a file (some parsers read a single database file); it still may not
 * be an ancestor of one.
 */
export function assertSafeCleanupTargets(targets: CleanupTarget[], homeDir: string): void {
  const protectedPaths = protectedCleanupPaths(homeDir);
  const fixedDirs = new Set(protectedPaths.slice(0, 3));
  for (const t of targets) {
    if (t.type !== "file" && t.type !== "directory") continue;
    if (!t.path || !isAbsolute(t.path)) {
      throw new UnsafeCleanupTargetError(
        `Refusing cleanup: target "${t.path}" is not an absolute path; nothing was deleted`
      );
    }
    const target = resolve(t.path);
    for (const p of protectedPaths) {
      if (!isWithin(p, target)) continue; // target is neither p nor an ancestor of it
      const same = target === p;
      if (same && t.type === "file" && !fixedDirs.has(p) && !isDirectory(p)) continue;
      throw new UnsafeCleanupTargetError(
        `Refusing cleanup: target "${t.path}" would delete ${same ? "" : "a directory containing "}"${p}"; nothing was deleted`
      );
    }
  }
}
