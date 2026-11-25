import type { TokmeterSummary } from "@sriinnu/tokmeter";
import { describe, expect, it, vi } from "vitest";
import {
  formatCost,
  formatNumber,
  printSummaryTables,
  renderDailyTable,
  renderModelsTable,
  renderProjectsTable,
  renderStats,
} from "./formatters.js";

function sampleSummary(overrides?: Partial<TokmeterSummary>): TokmeterSummary {
  return {
    records: [],
    projects: [
      {
        project: "alpha",
        totalTokens: 1_500_000,
        totalCost: 12.5,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        models: [],
        providers: [],
        dailyBreakdown: [],
        activeDays: 3,
        firstUsed: 1,
        lastUsed: 2,
      },
    ],
    models: [
      {
        model: "claude-sonnet-4-5",
        provider: "claude-code",
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        totalTokens: 1_500_000,
        cost: 12.5,
        percentageOfTotal: 100,
      },
    ],
    daily: [
      {
        date: "2026-11-24",
        totalTokens: 1_500_000,
        inputTokens: 1_000_000,
        outputTokens: 500_000,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 0,
        cost: 12.5,
        records: 4,
      },
    ],
    stats: {
      totalTokens: 1_500_000,
      totalCost: 12.5,
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalRecords: 4,
      projects: 1,
      models: 1,
      providers: 1,
      activeDays: 3,
      longestStreak: 2,
      firstUsed: 1,
      lastUsed: 2,
    },
    meta: {
      stableThrough: null,
      historySource: "none",
      todayState: "live",
      lastScanAt: 0,
      warnings: [],
      unpricedModels: [],
      unpricedRecords: 0,
    },
    ...overrides,
  };
}

describe("CLI formatters and table renderers", () => {
  it("formats compact token numbers and USD amounts", () => {
    expect(formatNumber(42)).toBe("42");
    expect(formatNumber(2_500)).toBe("2.5K");
    expect(formatNumber(3_400_000)).toBe("3.4M");
    expect(formatCost(12.5)).toBe("$12.50");
    expect(formatCost(0)).toBe("$0.00");
  });

  it("renders projects, models, daily, and stats tables", () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      out.push(String(msg ?? ""));
    });
    try {
      const s = sampleSummary();
      renderProjectsTable(s.projects);
      renderModelsTable(s.models);
      renderDailyTable(s.daily);
      renderStats(s.stats);
      printSummaryTables("overview", s);

      const joined = out.join("\n");
      expect(joined).toContain("alpha");
      expect(joined).toContain("claude-sonnet-4-5");
      expect(joined).toContain("2026-11-24");
      expect(joined).toContain("1.5M");
      expect(joined).toContain("$12.50");
      expect(joined).toContain("Cost total");
      expect(joined).toContain("Longest Streak");
    } finally {
      spy.mockRestore();
    }
  });

  it("prints empty-state setup instructions when totalRecords is 0", () => {
    const out: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
      out.push(String(msg ?? ""));
    });
    try {
      const empty = sampleSummary();
      empty.stats.totalRecords = 0;
      printSummaryTables("overview", empty);
      expect(out.join("\n")).toContain("No token usage data found.");
    } finally {
      spy.mockRestore();
    }
  });
});
