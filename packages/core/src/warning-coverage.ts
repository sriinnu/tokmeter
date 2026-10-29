/**
 * @sriinnu/tokmeter-core — Which days a scan fault can touch.
 *
 * A partial provider scan used to block every seal: the midnight rollover
 * refused to seal yesterday, and a rebuild refused to persist any day, as long
 * as ANY file in the scan had faulted — including a file that could not hold
 * a single record of the day in question. One permanently unreadable session
 * written to after midnight kept yesterday unsealed and today's accumulator
 * frozen on yesterday for as long as it stayed active.
 *
 * Session files are append-only, so a fault that names its file can be
 * placed in time: the file holds nothing newer than its last write, and
 * everything the parser did not read is at least as new as the last record
 * it did read. A fault blocks a day only when
 * that window overlaps the day. A fault that names no file (a provider crash)
 * still blocks every day.
 */

import { statSync } from "node:fs";
import { startOfLocalDay } from "./date-utils.js";
import type { ScanWarning } from "./types.js";

/** [start, end) of a local calendar day, DST-safe. */
function dayBounds(date: string): [number, number] {
  const start = startOfLocalDay(new Date(`${date}T00:00:00`).getTime());
  const end = startOfLocalDay(start + 26 * 3_600_000);
  return [start, end];
}

/** Whether a warning means the scan may be missing records dated `date`. */
export function faultTouchesDay(warning: ScanWarning, date: string): boolean {
  if (warning.scope !== "provider" || warning.notice) return false;
  if (!warning.file) return true;
  const [start, end] = dayBounds(date);
  // Everything left unread is at least as new as the last record read.
  if (warning.readThroughMs !== undefined && warning.readThroughMs >= end) return false;
  // Not the creation time: a restored or synced session file is new on disk
  // but holds old records. Its last write is still a hard upper bound.
  let mtimeMs: number;
  try {
    mtimeMs = statSync(warning.file).mtimeMs;
  } catch {
    return true; // gone or unreadable: can't place it, so it may touch the day
  }
  return mtimeMs >= start; // last written before the day began → can't hold it
}

/** Whether any warning may hide records dated `date`. */
export function warningsBlockDay(warnings: readonly ScanWarning[], date: string): boolean {
  return warnings.some((warning) => faultTouchesDay(warning, date));
}
