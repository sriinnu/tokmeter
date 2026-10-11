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
 *      `sessionRoots`), the Claude Code side directories the cleaner backs up,
 *      tokmeter's own alias/config files, and this backup's SQL dump dir.
 */

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { aliasFilePath } from "./alias-service.js";
import { claudeSessionSideDirs } from "./cleaners/claude-code.js";
import { configFilePath } from "./config-service.js";
import { ALL_PARSERS } from "./parsers/index.js";

/** One archive member as reported by `tar -t`. */
export interface ArchiveEntry {
  /** Member name exactly as tar lists it (leading "/" already stripped by tar). */
  name: string;
  /** First character of the `tar -tv` mode column: "-" file, "d" dir, "l" symlink, "h" hardlink, … */
  type: string;
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
  const names = splitLines(execFileSync("tar", ["-tzf", archivePath], { timeout: 30_000 }));
  const verbose = splitLines(execFileSync("tar", ["-tvzf", archivePath], { timeout: 30_000 }));
  if (names.length !== verbose.length) {
    throw new UnsafeArchiveError(
      "Archive listing is ambiguous (entry count mismatch) — refusing to extract"
    );
  }
  return names.map((name, i) => ({ name, type: verbose[i].charAt(0) }));
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
    if (hasDotDot(e.name)) {
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
 * Every path restore may write to for `homeDir`. Derived from the parsers'
 * own `sessionRoots` (the same functions their scans call) plus the paths
 * the cleaners and `createBackup` add to an archive.
 */
export function restoreAllowedRoots(homeDir: string, sqlDumpDir?: string): string[] {
  const roots = new Set<string>();
  for (const parser of ALL_PARSERS) {
    for (const root of parser.sessionRoots?.(homeDir) ?? []) {
      if (root) roots.add(resolve(root));
    }
  }
  for (const dir of Object.values(claudeSessionSideDirs(homeDir))) roots.add(resolve(dir));
  roots.add(resolve(aliasFilePath(homeDir)));
  roots.add(resolve(configFilePath(homeDir)));
  if (sqlDumpDir) roots.add(resolve(sqlDumpDir));
  // A root must never be the home dir, an ancestor of it, or the filesystem
  // root — any of those would turn the allowlist into "anything". A
  // misconfigured providerPath like "~" or "/" is dropped, not honoured.
  const home = resolve(homeDir);
  return [...roots].filter((r) => r !== resolve("/") && !isWithin(home, r));
}

/** True when `path` sits inside one of `roots`. */
export function isAllowedRestorePath(path: string, roots: string[]): boolean {
  return roots.some((root) => isWithin(path, root));
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
