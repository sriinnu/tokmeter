import { describe, expect, it } from "vitest";
import type { LiveData } from "../../hooks/useLiveData.js";
import type { TokmeterData } from "../../hooks/useTokmeterData.js";
import { buildDashboardInsights } from "./buildDashboardInsights.js";

function createLiveData(overrides?: Partial<LiveData>): LiveData {
  return {
    status: "disconnected",
    aggregated: null,
    lastUpdate: null,
    ...overrides,
  };
}

function createTokmeterData(): TokmeterData {
  return {
    records: [],
    stats: {
      totalTokens: 1_000,
      totalCost: 100,
      inputTokens: 500,
      outputTokens: 300,
      cacheReadTokens: 150,
      cacheWriteTokens: 50,
      reasoningTokens: 40,
      totalRecords: 12,
      projects: 2,
      models: 3,
      providers: 2,
      activeDays: 5,
      longestStreak: 3,
      firstUsed: 1_710_000_000_000,
      lastUsed: 1_710_086_400_000,
    },
    meta: {
      stableThrough: "2026-04-09",
      historySource: "snapshot",
      todayState: "live",
      lastScanAt: 1_710_086_400_000,
      warnings: [],
    },
    daily: [
      {
        date: "2026-04-06",
        totalTokens: 100,
        inputTokens: 50,
        outputTokens: 40,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
        reasoningTokens: 5,
        cost: 10,
        records: 2,
      },
      {
        date: "2026-04-07",
        totalTokens: 200,
        inputTokens: 100,
        outputTokens: 70,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        reasoningTokens: 10,
        cost: 20,
        records: 3,
      },
      {
        date: "2026-04-08",
        totalTokens: 300,
        inputTokens: 140,
        outputTokens: 100,
        cacheReadTokens: 40,
        cacheWriteTokens: 20,
        reasoningTokens: 12,
        cost: 30,
        records: 4,
      },
      {
        date: "2026-04-09",
        totalTokens: 400,
        inputTokens: 210,
        outputTokens: 90,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        reasoningTokens: 13,
        cost: 40,
        records: 3,
      },
    ],
    models: [
      {
        model: "gpt-4.1",
        provider: "openai",
        inputTokens: 240,
        outputTokens: 130,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        reasoningTokens: 12,
        totalTokens: 432,
        cost: 55,
        percentageOfTotal: 55,
      },
      {
        model: "claude-sonnet",
        provider: "anthropic",
        inputTokens: 200,
        outputTokens: 120,
        cacheReadTokens: 80,
        cacheWriteTokens: 30,
        reasoningTokens: 20,
        totalTokens: 450,
        cost: 35,
        percentageOfTotal: 35,
      },
      {
        model: "claude-opus",
        provider: "anthropic",
        inputTokens: 60,
        outputTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 10,
        reasoningTokens: 8,
        totalTokens: 158,
        cost: 10,
        percentageOfTotal: 10,
      },
    ],
    projects: [
      {
        project: "tokmeter",
        totalTokens: 600,
        totalCost: 60,
        inputTokens: 300,
        outputTokens: 200,
        cacheReadTokens: 70,
        cacheWriteTokens: 30,
        reasoningTokens: 20,
        models: [],
        providers: [
          {
            provider: "openai",
            totalTokens: 350,
            cost: 40,
            models: ["gpt-4.1"],
            percentageOfTotal: 66.6667,
          },
          {
            provider: "anthropic",
            totalTokens: 250,
            cost: 20,
            models: ["claude-sonnet"],
            percentageOfTotal: 33.3333,
          },
        ],
        dailyBreakdown: [
          {
            date: "2026-04-07",
            totalTokens: 100,
            inputTokens: 50,
            outputTokens: 40,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
            reasoningTokens: 5,
            cost: 10,
            records: 2,
          },
          {
            date: "2026-04-08",
            totalTokens: 200,
            inputTokens: 100,
            outputTokens: 70,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
            reasoningTokens: 10,
            cost: 20,
            records: 3,
          },
          {
            date: "2026-04-09",
            totalTokens: 300,
            inputTokens: 150,
            outputTokens: 90,
            cacheReadTokens: 40,
            cacheWriteTokens: 20,
            reasoningTokens: 5,
            cost: 30,
            records: 4,
          },
        ],
        activeDays: 3,
        firstUsed: 1_710_000_000_000,
        lastUsed: 1_710_086_400_000,
      },
      {
        project: "command-relay",
        totalTokens: 400,
        totalCost: 40,
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 80,
        cacheWriteTokens: 20,
        reasoningTokens: 20,
        models: [],
        providers: [
          {
            provider: "anthropic",
            totalTokens: 300,
            cost: 30,
            models: ["claude-sonnet", "claude-opus"],
            percentageOfTotal: 75,
          },
          {
            provider: "openai",
            totalTokens: 100,
            cost: 10,
            models: ["gpt-4.1"],
            percentageOfTotal: 25,
          },
        ],
        dailyBreakdown: [
          {
            date: "2026-04-06",
            totalTokens: 100,
            inputTokens: 50,
            outputTokens: 40,
            cacheReadTokens: 10,
            cacheWriteTokens: 0,
            reasoningTokens: 5,
            cost: 10,
            records: 2,
          },
          {
            date: "2026-04-08",
            totalTokens: 100,
            inputTokens: 40,
            outputTokens: 30,
            cacheReadTokens: 20,
            cacheWriteTokens: 10,
            reasoningTokens: 5,
            cost: 10,
            records: 2,
          },
          {
            date: "2026-04-09",
            totalTokens: 200,
            inputTokens: 110,
            outputTokens: 30,
            cacheReadTokens: 50,
            cacheWriteTokens: 10,
            reasoningTokens: 10,
            cost: 20,
            records: 1,
          },
        ],
        activeDays: 3,
        firstUsed: 1_709_900_000_000,
        lastUsed: 1_710_050_000_000,
      },
    ],
  };
}

describe("buildDashboardInsights", () => {
  it("aggregates provider totals across projects using real cost share", () => {
    const insights = buildDashboardInsights(createTokmeterData(), createLiveData());
    const anthropic = insights.providerInsights.find(
      (provider) => provider.provider === "anthropic"
    );
    const openai = insights.providerInsights.find((provider) => provider.provider === "openai");

    expect(anthropic).toMatchObject({
      provider: "anthropic",
      cost: 50,
      totalTokens: 550,
      projectCount: 2,
      modelCount: 2,
    });
    expect(openai).toMatchObject({
      provider: "openai",
      cost: 50,
      totalTokens: 450,
      projectCount: 2,
      modelCount: 1,
    });
    expect(anthropic?.percentageOfTotal).toBeCloseTo(50, 5);
    expect(openai?.percentageOfTotal).toBeCloseTo(50, 5);
  });

  it("builds project sparklines and cache-focused KPI copy", () => {
    const insights = buildDashboardInsights(createTokmeterData(), createLiveData());

    expect(insights.topProjects[0]?.project).toBe("tokmeter");
    expect(insights.topProjects[0]?.sparkline).toEqual([10, 20, 30]);
    expect(insights.kpis.find((kpi) => kpi.label === "Cache share")?.value).toBe("20%");
  });
});
