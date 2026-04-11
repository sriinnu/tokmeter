/**
 * @sriinnu/tokmeter-core — Frozen pre-today history snapshot storage.
 *
 * Persists records through yesterday so dashboards can reuse stable history
 * and only refresh today's overlay data unless a rescan or cleanup invalidates
 * the snapshot.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
const HISTORY_SNAPSHOT_VERSION = 1;
const SNAPSHOT_DIR_NAME = ".cache/tokmeter";
const SNAPSHOT_FILE_NAME = "history-snapshot.json";
function snapshotDir(homeDir) {
  return join(homeDir, SNAPSHOT_DIR_NAME);
}
function snapshotPath(homeDir) {
  return join(snapshotDir(homeDir), SNAPSHOT_FILE_NAME);
}
/** Load the frozen pre-today history snapshot if it matches the requested day key. */
export function loadHistorySnapshot(homeDir, expectedStableThrough) {
  const warnings = [];
  const filePath = snapshotPath(homeDir);
  if (!existsSync(filePath)) {
    return {
      records: [],
      stableThrough: null,
      historySource: "none",
      warnings,
    };
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const snapshot = JSON.parse(raw);
    if (snapshot.version !== HISTORY_SNAPSHOT_VERSION) {
      warnings.push({
        scope: "history",
        message: "History snapshot version changed — rebuilding frozen history.",
      });
      return {
        records: [],
        stableThrough: snapshot.stableThrough ?? null,
        historySource: "none",
        warnings,
      };
    }
    if (snapshot.stableThrough !== expectedStableThrough) {
      return {
        records: [],
        stableThrough: snapshot.stableThrough ?? null,
        historySource: "none",
        warnings,
      };
    }
    return {
      records: snapshot.records ?? [],
      stableThrough: snapshot.stableThrough,
      historySource: "snapshot",
      warnings,
    };
  } catch (error) {
    warnings.push({
      scope: "history",
      message: `History snapshot read failed — rebuilding frozen history (${toErrorMessage(error)}).`,
    });
    return {
      records: [],
      stableThrough: null,
      historySource: "none",
      warnings,
    };
  }
}
/** Persist the frozen pre-today history snapshot atomically. */
export function saveHistorySnapshot(homeDir, stableThrough, records) {
  const warnings = [];
  const dir = snapshotDir(homeDir);
  const filePath = snapshotPath(homeDir);
  const tempFilePath = `${filePath}.tmp`;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const now = new Date().toISOString();
    const snapshot = {
      version: HISTORY_SNAPSHOT_VERSION,
      stableThrough,
      createdAt: now,
      updatedAt: now,
      records,
    };
    writeFileSync(tempFilePath, JSON.stringify(snapshot), "utf-8");
    renameSync(tempFilePath, filePath);
  } catch (error) {
    warnings.push({
      scope: "cache",
      message: `History snapshot write failed — continuing with live data only (${toErrorMessage(error)}).`,
    });
  }
  return warnings;
}
/** Delete the frozen history snapshot after cleanup/restore so the next scan rebuilds it. */
export function invalidateHistorySnapshot(homeDir) {
  const filePath = snapshotPath(homeDir);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Non-blocking by design — callers should continue even if cache cleanup fails.
  }
}
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
