import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
const SUMMARY_CACHE_VERSION = 1;
const SUMMARY_CACHE_DIR_NAME = ".cache/tokmeter";
const SUMMARY_CACHE_FILE_NAME = "summary-cache.json";
function summaryCacheDir(homeDir) {
  return join(homeDir, SUMMARY_CACHE_DIR_NAME);
}
function summaryCachePath(homeDir) {
  return join(summaryCacheDir(homeDir), SUMMARY_CACHE_FILE_NAME);
}
/**
 * Load the persisted full-summary cache if present and compatible.
 */
export function loadSummaryCache(homeDir) {
  const warnings = [];
  const filePath = summaryCachePath(homeDir);
  if (!existsSync(filePath)) {
    return {
      summary: null,
      warnings,
    };
  }
  try {
    const raw = readFileSync(filePath, "utf-8");
    const snapshot = JSON.parse(raw);
    if (snapshot.version !== SUMMARY_CACHE_VERSION) {
      warnings.push({
        scope: "cache",
        message: "Summary cache version changed — rebuilding cached dashboard data.",
      });
      return {
        summary: null,
        warnings,
      };
    }
    return {
      summary: snapshot.summary ?? null,
      warnings,
    };
  } catch (error) {
    warnings.push({
      scope: "cache",
      message: `Summary cache read failed — rebuilding cached dashboard data (${toErrorMessage(error)}).`,
    });
    return {
      summary: null,
      warnings,
    };
  }
}
/**
 * Persist the full summary cache atomically for browser and daemon fallback.
 */
export function saveSummaryCache(homeDir, summary) {
  const warnings = [];
  const dir = summaryCacheDir(homeDir);
  const filePath = summaryCachePath(homeDir);
  const tempFilePath = `${filePath}.tmp`;
  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const payload = {
      version: SUMMARY_CACHE_VERSION,
      cachedAt: new Date().toISOString(),
      summary,
    };
    writeFileSync(tempFilePath, JSON.stringify(payload), "utf-8");
    renameSync(tempFilePath, filePath);
  } catch (error) {
    warnings.push({
      scope: "cache",
      message: `Summary cache write failed — continuing without persisted browser fallback (${toErrorMessage(error)}).`,
    });
  }
  return warnings;
}
/**
 * Remove the persisted summary cache after cleanup or restore.
 */
export function invalidateSummaryCache(homeDir) {
  const filePath = summaryCachePath(homeDir);
  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Non-blocking by design.
  }
}
function toErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
