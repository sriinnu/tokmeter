import { describe, expect, it } from "vitest";
import {
  buildReceiptData,
  renderReceiptMarkdown,
  renderReceiptSvg,
  renderReceiptText,
} from "./receipt.js";
import type { TokmeterSummary } from "./types.js";

function sampleSummary(): TokmeterSummary {
  return {
    records: [],
    projects: [
      {
        project: "/Users/alice/secret-repo",
        totalTokens: 1_200_000,
        totalCost: 12.5,
        inputTokens: 100_000,
        outputTokens: 50_000,
        cacheReadTokens: 900_000,
        cacheWriteTokens: 150_000,
        reasoningTokens: 0,
        models: [],
        providers: [],
        dailyBreakdown: [],
        activeDays: 1,
        firstUsed: 1,
        lastUsed: 2,
      },
    ],
    models: [
      {
        model: "claude-opus-4-6",
        provider: "claude-code",
        inputTokens: 80_000,
        outputTokens: 40_000,
        cacheReadTokens: 800_000,
        cacheWriteTokens: 120_000,
        reasoningTokens: 0,
        totalTokens: 1_040_000,
        cost: 10.5,
        percentageOfTotal: 84,
      },
      {
        model: "gpt-5.6",
        provider: "codex",
        inputTokens: 20_000,
        outputTokens: 10_000,
        cacheReadTokens: 100_000,
        cacheWriteTokens: 30_000,
        reasoningTokens: 0,
        totalTokens: 160_000,
        cost: 2.0,
        percentageOfTotal: 16,
      },
    ],
    daily: [
      {
        date: "2026-11-27",
        totalTokens: 1_200_000,
        inputTokens: 100_000,
        outputTokens: 50_000,
        cacheReadTokens: 900_000,
        cacheWriteTokens: 150_000,
        reasoningTokens: 0,
        cost: 12.5,
        records: 42,
      },
    ],
    stats: {
      totalTokens: 1_200_000,
      totalCost: 12.5,
      inputTokens: 100_000,
      outputTokens: 50_000,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 150_000,
      reasoningTokens: 0,
      totalRecords: 42,
      projects: 1,
      models: 2,
      providers: 2,
      activeDays: 1,
      longestStreak: 5,
      firstUsed: 1,
      lastUsed: 2,
    },
    meta: {
      stableThrough: "2026-11-26",
      historySource: "snapshot",
      todayState: "live",
      lastScanAt: 1_795_760_000_000,
      warnings: [],
      unpricedModels: [],
      unpricedRecords: 0,
    },
  };
}

describe("receipt builder and renderers", () => {
  it("scrubs project names by default and exposes them only when includeProjects is true", () => {
    const scrubbed = buildReceiptData(sampleSummary(), {
      label: "today (2026-11-27)",
      now: 1_795_760_000_000,
    });
    expect(scrubbed.privacyScrubbed).toBe(true);
    expect(scrubbed.projects).toEqual([]);
    expect(scrubbed.cacheHitRate).toBeCloseTo(900_000 / 1_150_000, 5);
    expect(renderReceiptText(scrubbed, { style: "thermal" })).not.toContain("secret-repo");
    expect(renderReceiptSvg(scrubbed, { style: "broadsheet" })).not.toContain("secret-repo");

    const withProjects = buildReceiptData(sampleSummary(), {
      label: "today (2026-11-27)",
      includeProjects: true,
      now: 1_795_760_000_000,
    });
    expect(withProjects.privacyScrubbed).toBe(false);
    expect(withProjects.projects).toHaveLength(1);
    expect(renderReceiptText(withProjects, { style: "broadsheet" })).toContain("secret-repo");
  });

  it("escapes hostile XML/Markdown characters cleanly in SVG and Markdown outputs", () => {
    const summary = sampleSummary();
    summary.models[0]!.model = "model-<script>&\"'evil";
    const data = buildReceiptData(summary, { label: "test & <scope>" });

    const svg = renderReceiptSvg(data, { style: "thermal" });
    expect(svg.startsWith("<svg ")).toBe(true);
    expect(svg.endsWith("</svg>")).toBe(true);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");

    const md = renderReceiptMarkdown(data);
    expect(md).toContain("Tokmeter Receipt");
    expect(md).toContain("claude-code");
  });
});
