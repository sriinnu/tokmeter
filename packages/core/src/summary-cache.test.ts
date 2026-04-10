import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { invalidateSummaryCache, loadSummaryCache, saveSummaryCache } from "./summary-cache.js";
import type { TokmeterSummary } from "./types.js";

const tempDirs: string[] = [];

function makeTempHomeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "tokmeter-summary-cache-"));
  tempDirs.push(dir);
  return dir;
}

function createSummary(): TokmeterSummary {
  return {
    records: [],
    projects: [],
    models: [],
    daily: [],
    stats: {
      totalTokens: 0,
      totalCost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalRecords: 0,
      projects: 0,
      models: 0,
      providers: 0,
      activeDays: 0,
      longestStreak: 0,
      firstUsed: 0,
      lastUsed: 0,
    },
    meta: {
      stableThrough: "2026-04-09",
      historySource: "snapshot",
      todayState: "live",
      lastScanAt: 123,
      warnings: [],
    },
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("summary cache", () => {
  it("round-trips a persisted summary", () => {
    const homeDir = makeTempHomeDir();
    const summary = createSummary();

    const saveWarnings = saveSummaryCache(homeDir, summary);
    const loaded = loadSummaryCache(homeDir);

    expect(saveWarnings).toEqual([]);
    expect(loaded.warnings).toEqual([]);
    expect(loaded.summary).toEqual(summary);
  });

  it("invalidates the persisted cache", () => {
    const homeDir = makeTempHomeDir();
    saveSummaryCache(homeDir, createSummary());

    invalidateSummaryCache(homeDir);
    const loaded = loadSummaryCache(homeDir);

    expect(loaded.summary).toBeNull();
  });
});
