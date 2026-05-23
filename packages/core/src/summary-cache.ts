import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ScanWarning, TokmeterSummary } from "./types.js";

interface SummaryCacheFile {
  version: number;
  cachedAt: string;
  summary: TokmeterSummary;
}

export interface LoadedSummaryCache {
  summary: TokmeterSummary | null;
  warnings: ScanWarning[];
}

const SUMMARY_CACHE_VERSION = 2;
const SUMMARY_CACHE_DIR_NAME = ".cache/tokmeter";
const SUMMARY_CACHE_FILE_NAME = "summary-cache.json";

function summaryCacheDir(homeDir: string): string {
  return join(homeDir, SUMMARY_CACHE_DIR_NAME);
}

function summaryCachePath(homeDir: string): string {
  return join(summaryCacheDir(homeDir), SUMMARY_CACHE_FILE_NAME);
}

/**
 * Load the persisted full-summary cache if present and compatible.
 */
export function loadSummaryCache(homeDir: string): LoadedSummaryCache {
  const warnings: ScanWarning[] = [];
  const filePath = summaryCachePath(homeDir);

  if (!existsSync(filePath)) {
    return {
      summary: null,
      warnings,
    };
  }

  try {
    const raw = readFileSync(filePath, "utf-8");
    const snapshot = JSON.parse(raw) as SummaryCacheFile;

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
export function saveSummaryCache(homeDir: string, summary: TokmeterSummary): ScanWarning[] {
  const warnings: ScanWarning[] = [];
  const dir = summaryCacheDir(homeDir);
  const filePath = summaryCachePath(homeDir);
  const tempFilePath = `${filePath}.tmp`;

  try {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const payload: SummaryCacheFile = {
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
export function invalidateSummaryCache(homeDir: string): void {
  const filePath = summaryCachePath(homeDir);

  try {
    if (existsSync(filePath)) {
      unlinkSync(filePath);
    }
  } catch {
    // Non-blocking by design.
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
