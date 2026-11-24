/**
 * @sriinnu/tokmeter-core — Pending restore queue.
 *
 * `CleanupService.restore()` restores session files to disk synchronously and
 * records the affected paths here. The next `TokmeterCore.scan()` or
 * `refreshToday()` consumes the queue and reconciles the restored days into
 * `~/.cache/tokmeter/aggregates/*.json` even when the relay already has files
 * up through yesterday (bypassing `maxOnDisk >= yesterday`).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ensurePrivateFile, writePrivateFile } from "./private-files.js";

const PENDING_RESTORE_REL = ".cache/tokmeter/pending-restore.json";
const MAX_PENDING_BYTES = 16 * 1024 * 1024;

export interface PendingRestoreBatch {
  restoredPaths: string[];
  existedBefore: string[];
}

interface PendingRestoreFile {
  version: 1;
  batches: PendingRestoreBatch[];
}

export function pendingRestorePath(homeDir: string): string {
  return join(homeDir, PENDING_RESTORE_REL);
}

function readPendingFile(filePath: string): PendingRestoreBatch[] {
  if (!existsSync(filePath)) return [];
  try {
    ensurePrivateFile(filePath);
    const raw = readFileSync(filePath, "utf-8");
    if (Buffer.byteLength(raw, "utf-8") > MAX_PENDING_BYTES) return [];
    const parsed = JSON.parse(raw) as Partial<PendingRestoreFile>;
    if (parsed?.version !== 1 || !Array.isArray(parsed.batches)) return [];
    const batches: PendingRestoreBatch[] = [];
    for (const b of parsed.batches) {
      if (!b || typeof b !== "object") continue;
      if (!Array.isArray(b.restoredPaths) || !Array.isArray(b.existedBefore)) continue;
      const restoredPaths = b.restoredPaths.filter(
        (p): p is string => typeof p === "string" && p.length > 0
      );
      const existedBefore = b.existedBefore.filter(
        (p): p is string => typeof p === "string" && p.length > 0
      );
      if (restoredPaths.length > 0) batches.push({ restoredPaths, existedBefore });
    }
    return batches;
  } catch {
    return [];
  }
}

export function hasPendingRestores(homeDir: string): boolean {
  return existsSync(pendingRestorePath(homeDir));
}

export function recordPendingRestore(homeDir: string, batch: PendingRestoreBatch): void {
  if (batch.restoredPaths.length === 0) return;
  const filePath = pendingRestorePath(homeDir);
  const existing = readPendingFile(filePath);
  existing.push({
    restoredPaths: batch.restoredPaths.map((p) => resolve(p)),
    existedBefore: batch.existedBefore.map((p) => resolve(p)),
  });
  const payload: PendingRestoreFile = { version: 1, batches: existing };
  writePrivateFile(filePath, JSON.stringify(payload));
}

export function takePendingRestores(homeDir: string): PendingRestoreBatch[] {
  const filePath = pendingRestorePath(homeDir);
  if (!existsSync(filePath)) return [];
  const processing = join(
    dirname(filePath),
    `.pending-restore.${process.pid}.${randomBytes(6).toString("hex")}.tmp`
  );
  try {
    ensurePrivateFile(filePath);
    renameSync(filePath, processing);
  } catch {
    return [];
  }
  try {
    return readPendingFile(processing);
  } finally {
    try {
      unlinkSync(processing);
    } catch {
      /* best effort */
    }
  }
}

export function prunePendingRestorePaths(homeDir: string, deletedPaths: string[]): void {
  if (deletedPaths.length === 0) return;
  const filePath = pendingRestorePath(homeDir);
  if (!existsSync(filePath)) return;
  const deleted = deletedPaths.map((p) => resolve(p));
  const matchesDeleted = (p: string) => {
    const rp = resolve(p);
    return deleted.some((d) => rp === d || rp.startsWith(`${d}${sep}`));
  };
  const batches = readPendingFile(filePath);
  if (batches.length === 0) return;
  let changed = false;
  const next: PendingRestoreBatch[] = [];
  for (const b of batches) {
    const restoredPaths = b.restoredPaths.filter((p) => {
      if (matchesDeleted(p)) {
        changed = true;
        return false;
      }
      return true;
    });
    const existedBefore = b.existedBefore.filter((p) => !matchesDeleted(p));
    if (restoredPaths.length > 0) next.push({ restoredPaths, existedBefore });
  }
  if (!changed) return;
  if (next.length === 0) {
    try {
      unlinkSync(filePath);
    } catch {
      /* best effort */
    }
  } else {
    writePrivateFile(
      filePath,
      JSON.stringify({ version: 1, batches: next } satisfies PendingRestoreFile)
    );
  }
}
