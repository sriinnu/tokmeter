/** Owner-only storage for Tokmeter's derived data and user settings. */

import { randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

function assertOwned(path: string, uid: number): void {
  const owner = process.getuid?.();
  if (owner !== undefined && uid !== owner) {
    throw new Error(`Refusing to change storage not owned by this user: ${path}`);
  }
}

/** Lock down an app-owned directory, including one created by an older build. */
export function ensurePrivateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) {
    throw new Error(`Private storage path is not a regular directory: ${path}`);
  }
  assertOwned(path, st.uid);
  if ((st.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

/** Tighten an existing known Tokmeter file; never follow a symlink or hardlink. */
export function ensurePrivateFile(path: string): void {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) {
    throw new Error(`Private storage path is not a singly linked regular file: ${path}`);
  }
  assertOwned(path, st.uid);
  if ((st.mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

/** Atomic replacement; the new inode is 0600 regardless of process umask. */
export function writePrivateFile(path: string, contents: string | Buffer): void {
  ensurePrivateDirectory(dirname(path));
  const tmp = join(dirname(path), `.${randomBytes(12).toString("hex")}.tmp`);
  const fd = openSync(
    tmp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
    0o600
  );
  try {
    writeFileSync(fd, contents);
  } catch (error) {
    closeSync(fd);
    unlinkSync(tmp);
    throw error;
  }
  closeSync(fd);
  try {
    renameSync(tmp, path);
  } catch (error) {
    unlinkSync(tmp);
    throw error;
  }
}
