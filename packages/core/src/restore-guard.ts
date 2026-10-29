/**
 * @sriinnu/tokmeter-core — restore safety checks.
 *
 * A backup archive is untrusted input: snapshots are made to be copied
 * between machines, so the archive restored here may not be one this machine
 * wrote. Restore therefore never lets the archive decide where bytes land:
 *
 *   1. List entries + types up front and reject anything that is not a
 *      regular file or directory (symlink, hardlink, device, fifo, …) and any
 *      `..` segment.
 *   2. Extract into a private 0700 temp dir and re-check the extracted tree
 *      with lstat (no symlinks, regular files only, single link, no escapes).
 *   3. Only copy a file into place when its destination is inside an allowed
 *      root: the session paths the scanner itself reads (each parser's
 *      `restoreRoots`, else `sessionRoots`), the Claude Code side directories
 *      the cleaner backs up, tokmeter's own alias/config files, and this
 *      backup's SQL dump dir.
 *
 * Claude Code's `session-env` directory is backed up by cleanup but never
 * restored: Claude Code executes the hook scripts it finds there, so writing
 * archive bytes into it would let a snapshot plant code that runs on the next
 * session start. Restore reports those entries as skipped.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { aliasFilePath } from "./alias-service.js";
import { claudeSessionSideDirs } from "./cleaners/claude-code.js";
import { configFilePath } from "./config-service.js";
import { ALL_PARSERS } from "./parsers/index.js";
import { ANY_PATH_SEGMENT } from "./parsers/utils.js";

/** One archive member as reported by `tar -t`. */
export interface ArchiveEntry {
  /** Member name exactly as tar lists it (leading "/" already stripped by tar). */
  name: string;
  /** First character of the `tar -tv` mode column: "-" file, "d" dir, "l" symlink, "h" hardlink, … */
  type: string;
  /** Uncompressed size from tar's verbose listing. */
  sizeBytes?: number;
}

/** Thrown when an archive or extracted tree fails a safety check. */
export class UnsafeArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeArchiveError";
  }
}

/**
 * Read member names and types from a .tar.gz. Works on bsdtar (macOS) and GNU
 * tar: names come from `tar -tzf` (unambiguous, one per line), types from the
 * first column of `tar -tvzf`. Both list in archive order, so they pair by
 * line; a count mismatch (e.g. a name containing a newline) is refused rather
 * than guessed at.
 */
export function listArchiveEntries(archivePath: string): ArchiveEntry[] {
  const options = { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 };
  const names = splitLines(execFileSync("tar", ["-tzf", archivePath], options));
  const verbose = splitLines(execFileSync("tar", ["-tvzf", archivePath], options));
  if (names.length !== verbose.length) {
    throw new UnsafeArchiveError(
      "Archive listing is ambiguous (entry count mismatch) — refusing to extract"
    );
  }
  return names.map((name, i) => {
    const row = verbose[i];
    const fields = row.trim().split(/\s+/);
    // bsdtar: mode, links, user, group, size, date...;
    // GNU tar: mode, user/group, size, date...
    const sizeField = /^\d+$/.test(fields[1] ?? "") ? fields[4] : fields[2];
    const sizeBytes = Number(sizeField);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new UnsafeArchiveError(`Cannot determine archive entry size for "${name}"`);
    }
    return { name, type: row.charAt(0), sizeBytes };
  });
}

function splitLines(buf: Buffer): string[] {
  return buf
    .toString()
    .split("\n")
    .filter((line) => line.length > 0);
}

/** True when any segment of a member name is "..". */
function hasDotDot(name: string): boolean {
  return name.split(/[\\/]+/).some((seg) => seg === "..");
}

/**
 * Reject entries whose type is not a regular file or directory, and any
 * entry with a ".." segment. Throws {@link UnsafeArchiveError}.
 */
export function assertSafeEntries(entries: ArchiveEntry[]): void {
  for (const e of entries) {
    if (hasDotDot(e.name) || isAbsolute(e.name) || e.name.includes("\0")) {
      throw new UnsafeArchiveError(
        `Archive contains path traversal entry "${e.name}" — refusing to extract`
      );
    }
    if (e.type !== "-" && e.type !== "d") {
      throw new UnsafeArchiveError(
        `Archive entry "${e.name}" is a ${describeType(e.type)}, not a regular file — refusing to extract`
      );
    }
  }
}

/** Bound extraction before tar can consume disk with a compressed archive. */
export function assertArchiveLimits(
  entries: ArchiveEntry[],
  availableBytes: number,
  maxExpandedBytes = 64 * 1024 ** 3,
  maxEntries = 250_000
): void {
  if (entries.length > maxEntries) {
    throw new UnsafeArchiveError(`Archive has too many entries (${entries.length})`);
  }
  let total = 0;
  for (const e of entries) {
    if (!Number.isSafeInteger(e.sizeBytes) || (e.sizeBytes ?? -1) < 0) {
      throw new UnsafeArchiveError(`Archive entry "${e.name}" has no trustworthy size`);
    }
    if (e.type === "-") total += e.sizeBytes ?? 0;
    if (total > maxExpandedBytes) {
      throw new UnsafeArchiveError("Archive exceeds the expanded-size limit");
    }
  }
  // Keep enough free space for the rest of the machine to stay functional.
  if (total > Math.max(0, availableBytes - 512 * 1024 ** 2)) {
    throw new UnsafeArchiveError("Archive needs more free disk space than restore allows");
  }
}

function describeType(type: string): string {
  switch (type) {
    case "l":
      return "symlink";
    case "h":
      return "hardlink";
    case "c":
    case "b":
      return "device";
    case "p":
      return "fifo";
    case "s":
      return "socket";
    default:
      return `special entry (type "${type}")`;
  }
}

/** True when `path` equals `root` or lies beneath it (lexical, resolved). */
export function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

/**
 * True when `path` equals `root` or lies beneath it. A root segment equal to
 * {@link ANY_PATH_SEGMENT} matches exactly one segment of `path`.
 */
export function isWithinRoot(path: string, root: string): boolean {
  if (!root.includes(ANY_PATH_SEGMENT)) return isWithin(path, root);
  const rootParts = resolve(root).split(sep);
  const pathParts = resolve(path).split(sep);
  if (pathParts.length < rootParts.length) return false;
  return rootParts.every((seg, i) =>
    seg === ANY_PATH_SEGMENT ? pathParts[i] !== "" : seg === pathParts[i]
  );
}

/**
 * Directories cleanup backs up that restore deliberately never writes into.
 * Archive entries under these are skipped (and reported), not refused.
 */
export function restoreSkippedRoots(homeDir: string): string[] {
  return [resolve(claudeSessionSideDirs(homeDir).sessionEnv)];
}

/**
 * Every path restore may write to for `homeDir`. Derived from the parsers'
 * own `restoreRoots`/`sessionRoots` (the same functions their scans call)
 * plus the paths the cleaners and `createBackup` add to an archive.
 */
export function restoreAllowedRoots(homeDir: string, sqlDumpDir?: string): string[] {
  const roots = new Set<string>();
  for (const parser of ALL_PARSERS) {
    const parserRoots = parser.restoreRoots?.(homeDir) ?? parser.sessionRoots?.(homeDir) ?? [];
    for (const root of parserRoots) {
      if (root) roots.add(resolve(root));
    }
  }
  const skipped = restoreSkippedRoots(homeDir);
  for (const dir of Object.values(claudeSessionSideDirs(homeDir))) {
    if (!skipped.includes(resolve(dir))) roots.add(resolve(dir));
  }
  roots.add(resolve(aliasFilePath(homeDir)));
  roots.add(resolve(configFilePath(homeDir)));
  if (sqlDumpDir) roots.add(resolve(sqlDumpDir));
  // A root must never be the home dir, an ancestor of it, or the filesystem
  // root — any of those would turn the allowlist into "anything". A
  // misconfigured providerPath like "~" or "/" is dropped, not honoured.
  const home = resolve(homeDir);
  // Nor may a root reach into a skipped directory (a providerPath pointing at
  // ~/.claude/session-env would otherwise re-open it).
  return [...roots].filter(
    (r) =>
      r !== resolve("/") &&
      !isWithin(home, r) &&
      !skipped.some((s) => isWithin(r, s) || isWithin(s, r))
  );
}

/** True when `path` sits inside one of `roots`. */
export function isAllowedRestorePath(path: string, roots: string[]): boolean {
  return roots.some((root) => isWithinRoot(path, root));
}

/** Do not let an existing parent symlink redirect a lexically allowed copy. */
export function assertNoSymlinkParents(dest: string, homeDir: string, roots: string[]): void {
  const home = resolve(homeDir);
  const root = roots.find((candidate) => isWithinRoot(dest, candidate));
  if (!root) throw new UnsafeArchiveError(`Restore destination is not allowlisted: ${dest}`);
  // Under HOME, trust only the already-open home path and inspect every child.
  // For an explicitly configured external root, inspect from the filesystem
  // root; a symlink in ANY ancestor could redirect the supposedly allowed path.
  const start = isWithin(dest, home) ? home : parse(resolve(dest)).root;
  const startStat = lstatSync(start);
  if (startStat.isSymbolicLink() || !startStat.isDirectory()) {
    throw new UnsafeArchiveError(`Restore destination has an unsafe parent: ${start}`);
  }
  const rel = relative(start, dirname(dest));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafeArchiveError(`Restore destination escapes its trusted base: ${dest}`);
  }
  let current = start;
  for (const part of rel.split(sep).filter(Boolean)) {
    current = join(current, part);
    try {
      const st = lstatSync(current);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        throw new UnsafeArchiveError(`Restore destination has an unsafe parent: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

/**
 * Walk an extracted tree with lstat and return its regular files. Throws on
 * any symlink, special file, multiply-linked file, or path that escapes
 * `root`. Directories are descended, never followed through links.
 */
export function collectExtractedFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (!isWithin(full, root)) {
        throw new UnsafeArchiveError(`Extracted path escapes the restore sandbox: ${name}`);
      }
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new UnsafeArchiveError(
          `Extracted tree contains a symlink (${relative(root, full)}) — refusing`
        );
      }
      if (st.isDirectory()) {
        walk(full);
      } else if (st.isFile()) {
        if (st.nlink > 1) {
          throw new UnsafeArchiveError(
            `Extracted tree contains a hardlinked file (${relative(root, full)}) — refusing`
          );
        }
        out.push(full);
      } else {
        throw new UnsafeArchiveError(
          `Extracted tree contains a special file (${relative(root, full)}) — refusing`
        );
      }
    }
  };
  walk(root);
  return out;
}
