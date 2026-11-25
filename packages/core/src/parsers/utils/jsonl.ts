/**
 * @sriinnu/tokmeter-core — Bounded JSON and JSONL streaming readers.
 */

import { type FileHandle, open, readFile, stat } from "node:fs/promises";

const MAX_JSONL_LINE_CHARS = 8 * 1024 * 1024;
const OVERSIZED_KEEP_BYTES = 64 * 1024;
export const MAX_JSONL_RECORDS = 600_000;
const MAX_JSONL_INPUT_BYTES = 128 * 1024 * 1024;

/** What a {@link visitJsonlLines} pass consumed. */
export interface JsonlVisitResult {
  /**
   * Byte offset just past the last line handed to the visitor (or skipped as
   * oversized). An unterminated tail that doesn't parse is a write caught in
   * flight: it is NOT consumed, so a cache keyed on this offset re-reads it
   * once the writer finishes the line.
   */
  consumedThroughBytes: number;
  /** stat of the descriptor that was read, taken before reading. */
  snapshot: { mtimeMs: number; sizeBytes: number };
  /** Lines longer than the cap that were skipped instead of parsed. */
  oversizedLines: number;
  /**
   * The file ends in a line still being written. It is left unconsumed, but
   * it may be a record dated before midnight: a seal must wait for it.
   */
  inFlightTail: boolean;
}

/** Head + tail of a line too long to buffer, for best-effort field recovery. */
export interface OversizedLine {
  head: string;
  tail: string;
  bytes: number;
}

class JsonlLimitError extends Error {
  readonly partialResults: unknown[];

  constructor(path: string, problem: string, partialResults: unknown[]) {
    super(`Refusing to parse ${path}: JSONL ${problem}`);
    this.name = "JsonlLimitError";
    this.partialResults = partialResults;
  }
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

/**
 * Stream a JSONL file from `startBytes`, handing each complete line to `visit`
 * as a string. Unlike {@link readJsonlFile} nothing is accumulated, so memory
 * is one line (≤ `maxLineBytes`) regardless of file size — there is no
 * whole-file size refusal. A line over the cap is skipped, not fatal: its
 * first and last 64 KB go to `onOversized` (so a caller can recover fields
 * from it) and reading continues with the next line. The old reader threw at
 * the first such line and dropped the rest of the file: one 16 MB tool output
 * hid every later response in a 63 MB Codex rollout, and a Claude Code
 * session past 128 MiB stopped counting entirely.
 *
 * If `startBytes` is not at a line boundary, the partial first line is
 * discarded. Faults (EACCES, EIO, a vanished file) propagate to the caller.
 */
export async function visitJsonlLines(
  path: string,
  startBytes: number,
  visit: (line: string) => void,
  opts?: { maxLineBytes?: number; onOversized?: (line: OversizedLine) => void }
): Promise<JsonlVisitResult> {
  const maxLineBytes = opts?.maxLineBytes ?? MAX_JSONL_LINE_CHARS;
  const fd = await open(path, "r");
  try {
    const st = await fd.stat();
    if (st.isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), {
        code: "EISDIR",
      });
    }
    const snapshot = { mtimeMs: st.mtimeMs, sizeBytes: st.size };
    const result: JsonlVisitResult = {
      consumedThroughBytes: startBytes,
      snapshot,
      oversizedLines: 0,
      inFlightTail: false,
    };
    if (startBytes >= st.size) {
      result.consumedThroughBytes = Math.min(startBytes, st.size);
      return result;
    }
    let discardFirst = false;
    if (startBytes > 0) {
      const boundary = Buffer.alloc(1);
      await fd.read(boundary, 0, 1, startBytes - 1);
      discardFirst = boundary[0] !== 10;
    }
    let pieces: Buffer[] = [];
    let lineBytes = 0;
    let oversized = false;
    let head = Buffer.alloc(0);
    let tail = Buffer.alloc(0);
    let pos = startBytes;
    let lineStart = startBytes;

    const endLine = (endPos: number) => {
      if (discardFirst) {
        discardFirst = false;
      } else if (oversized) {
        result.oversizedLines++;
        opts?.onOversized?.({
          head: head.toString("utf8"),
          tail: tail.toString("utf8"),
          bytes: lineBytes,
        });
      } else if (lineBytes > 0) {
        visit(Buffer.concat(pieces, lineBytes).toString("utf8"));
      }
      pieces = [];
      lineBytes = 0;
      oversized = false;
      head = Buffer.alloc(0);
      tail = Buffer.alloc(0);
      lineStart = endPos;
      result.consumedThroughBytes = endPos;
    };
    const take = (chunk: Buffer) => {
      if (chunk.length === 0) return;
      lineBytes += chunk.length;
      if (discardFirst) return;
      if (!oversized && lineBytes > maxLineBytes) {
        oversized = true;
        const all = Buffer.concat(pieces);
        head = Buffer.from(all.subarray(0, OVERSIZED_KEEP_BYTES));
        tail = Buffer.from(all.subarray(Math.max(0, all.length - OVERSIZED_KEEP_BYTES)));
        pieces = [];
      }
      if (oversized) {
        if (head.length < OVERSIZED_KEEP_BYTES) {
          head = Buffer.concat([head, chunk.subarray(0, OVERSIZED_KEEP_BYTES - head.length)]);
        }
        const joined = Buffer.concat([tail, chunk]);
        tail = Buffer.from(joined.subarray(Math.max(0, joined.length - OVERSIZED_KEEP_BYTES)));
      } else {
        pieces.push(chunk);
      }
    };

    const stream = fd.createReadStream({ start: startBytes, end: st.size - 1, autoClose: false });
    for await (const raw of stream) {
      const chunk = raw as Buffer;
      let from = 0;
      let nl = chunk.indexOf(10, from);
      while (nl >= 0) {
        take(chunk.subarray(from, nl));
        endLine(pos + nl + 1);
        from = nl + 1;
        nl = chunk.indexOf(10, from);
      }
      take(chunk.subarray(from));
      pos += chunk.length;
    }
    // Unterminated tail: consume it only if it is a complete JSON value (a
    // writer that hasn't added the newline yet); otherwise it is in flight.
    if (lineBytes > 0 && !discardFirst && !oversized) {
      const text = Buffer.concat(pieces, lineBytes).toString("utf8");
      let complete = false;
      try {
        JSON.parse(text);
        complete = true;
      } catch {
        /* in flight */
      }
      if (complete) {
        visit(text);
        result.consumedThroughBytes = st.size;
      } else {
        result.consumedThroughBytes = lineStart;
        result.inFlightTail = true;
      }
    } else if (lineBytes > 0 && oversized) {
      result.inFlightTail = true; // an oversized line still being written
    } else if (lineBytes === 0) {
      result.consumedThroughBytes = Math.max(result.consumedThroughBytes, lineStart);
    }
    return result;
  } finally {
    try {
      await fd.close();
    } catch {
      /* best-effort */
    }
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
