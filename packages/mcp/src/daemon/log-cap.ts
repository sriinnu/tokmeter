/**
 * Keeps the daemon's launchd logs bounded.
 *
 * launchd opens StandardOutPath/StandardErrorPath once, for the life of the
 * process, and never rotates them. Nothing else did either: by 2026-11-17
 * daemon.err.log had reached 261 MB, almost all of it one kosha warning
 * repeated per model on every refresh (kosha fixed that line in 1.17). The
 * next noisy dependency would do the same, so the cap lives here.
 *
 * Copy-truncate, not rename: launchd's fd stays open on the original path, so
 * a renamed file would keep growing under its new name. Truncating in place is
 * safe because launchd opens these files with O_APPEND (`lsof +fg` shows `AP`):
 * the next write lands at the new end of file, offset 0, with no sparse hole.
 *
 * Node writes stdout/stderr to files synchronously and every step here is
 * sync, so none of this process's own lines can land between the copy and the
 * truncate. Another process sharing the files (a daemon losing the singleton
 * race) could, in a window of milliseconds; that is accepted.
 */
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

/** A log over this size is rotated. */
export const LOG_CAP_BYTES = 10 * 1024 * 1024;
/** How often the running daemon checks: one stat per log, so it can be often. */
export const LOG_CAP_CHECK_MS = 5 * 60 * 1000;
/** The files launchd writes for the daemon (see launchd.ts renderAgentPlist). */
export const DAEMON_LOG_NAMES = ["daemon.out.log", "daemon.err.log"] as const;

export type CapResult =
  | { rotated: false }
  /** `kept` is false when `.1` could not be written (e.g. disk full) and the tail was dropped. */
  | { rotated: true; kept: boolean; error?: string };

/** The newest `capBytes` of the file, starting at a whole line when there is one. */
function readTail(path: string, capBytes: number): Buffer {
  const fd = openSync(path, "r");
  try {
    const end = fstatSync(fd).size;
    const start = Math.max(0, end - capBytes);
    const buf = Buffer.alloc(end - start);
    let off = 0;
    while (off < buf.length) {
      const n = readSync(fd, buf, off, buf.length - off, start + off);
      if (n === 0) break;
      off += n;
    }
    const tail = buf.subarray(0, off);
    if (start === 0) return tail;
    // Started mid-file: drop the partial first line, unless there is no line
    // break at all, in which case the raw tail beats keeping nothing.
    const nl = tail.indexOf(0x0a);
    return nl === -1 ? tail : tail.subarray(nl + 1);
  } finally {
    closeSync(fd);
  }
}

function writePrevious(previous: string, tail: Buffer): void {
  const tmp = `${previous}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, tail, { mode: 0o600 });
    renameSync(tmp, previous);
  } catch (err) {
    rmSync(tmp, { force: true, recursive: true });
    throw err;
  }
}

/**
 * If `path` is over `capBytes`, keep its newest `capBytes` in `path.1`,
 * replacing any older one, and truncate `path` to empty. A missing file is not
 * an error.
 *
 * The truncate happens even when `.1` can't be written: the runaway log this
 * exists for is the one most likely to have filled the disk, and leaving it in
 * place would retry and fail forever. It first frees the old `.1` and retries,
 * and the result says when the tail was lost so the caller can report it.
 */
export function capLogFile(path: string, capBytes = LOG_CAP_BYTES): CapResult {
  let size: number;
  try {
    const st = statSync(path);
    if (st.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, stat '${path}'`), {
        code: "EISDIR",
      });
    }
    size = st.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EISDIR") throw err;
    return { rotated: false };
  }
  if (size <= capBytes) return { rotated: false };

  const tail = readTail(path, capBytes);
  const previous = `${path}.1`;
  let error: string | undefined;
  try {
    writePrevious(previous, tail);
  } catch {
    try {
      rmSync(previous, { force: true, recursive: true });
      writePrevious(previous, tail);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  truncateSync(path, 0);
  return error === undefined
    ? { rotated: true, kept: true }
    : { rotated: true, kept: false, error };
}

/**
 * Cap every daemon log in `dir`, then say so in the fresh log, so an emptied
 * log points at `.1` instead of looking clean. One failing file never stops
 * the others, and nothing here throws.
 */
export function capDaemonLogs(dir: string, capBytes = LOG_CAP_BYTES): string[] {
  const rotated: string[] = [];
  for (const name of DAEMON_LOG_NAMES) {
    try {
      const r = capLogFile(join(dir, name), capBytes);
      if (!r.rotated) continue;
      rotated.push(name);
      const mb = Math.round(capBytes / (1024 * 1024));
      const note = r.kept
        ? `log cap: ${name} passed ${mb} MB; its newest ${mb} MB are in ${name}.1`
        : `log cap: ${name} passed ${mb} MB and was emptied; ${name}.1 could not be written (${r.error}), so that output is lost`;
      if (name === "daemon.out.log") console.log(note);
      else console.error(note);
    } catch (err) {
      console.error(`log cap: could not rotate ${name}:`, err instanceof Error ? err.message : err);
    }
  }
  return rotated;
}
