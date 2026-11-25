/**
 * tokmeter CLI numeric/currency formatters and table renderers.
 */

import type {
  ModelSummary,
  ProjectSummary,
  TokmeterCore,
  TokmeterSummary,
} from "@sriinnu/tokmeter";
import Table from "cli-table3";

export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function renderProjectsTable(projects: ProjectSummary[]): void {
  const table = new Table({
    head: ["Project", "Tokens", "Cost", "Models", "Providers", "Active Days"],
    colWidths: [25, 12, 10, 8, 10, 12],
  });

  for (const p of projects) {
    table.push([
      p.project,
      formatNumber(p.totalTokens),
      formatCost(p.totalCost),
      p.models.length.toString(),
      p.providers.length.toString(),
      p.activeDays.toString(),
    ]);
  }
  console.log(table.toString());
}

export function renderModelsTable(models: ModelSummary[]): void {
  const table = new Table({
    head: ["Model", "Provider", "Tokens", "Input", "Output", "Cache R", "Cache W", "Cost", "%"],
    colWidths: [24, 12, 10, 10, 10, 10, 10, 10, 6],
  });

  for (const m of models) {
    table.push([
      m.model,
      m.provider,
      formatNumber(m.totalTokens),
      formatNumber(m.inputTokens),
      formatNumber(m.outputTokens),
      formatNumber(m.cacheReadTokens),
      formatNumber(m.cacheWriteTokens),
      formatCost(m.cost),
      `${m.percentageOfTotal.toFixed(1)}%`,
    ]);
  }
  console.log(table.toString());
}

export function renderDailyTable(daily: ReturnType<TokmeterCore["getDailyBreakdown"]>): void {
  const table = new Table({
    head: ["Date", "Tokens", "Input", "Output", "Cost", "Records"],
    colWidths: [12, 12, 12, 12, 10, 8],
  });

  for (const d of daily) {
    table.push([
      d.date,
      formatNumber(d.totalTokens),
      formatNumber(d.inputTokens),
      formatNumber(d.outputTokens),
      formatCost(d.cost),
      d.records.toString(),
    ]);
  }
  console.log(table.toString());
}

export function renderStats(stats: ReturnType<TokmeterCore["getStats"]>): void {
  const table = new Table({
    head: ["Metric", "Value"],
    colWidths: [20, 30],
  });

  table.push(
    ["Total Tokens", formatNumber(stats.totalTokens)],
    ["Cost total (not a bill)", formatCost(stats.totalCost)],
    ["Input Tokens", formatNumber(stats.inputTokens)],
    ["Output Tokens", formatNumber(stats.outputTokens)],
    ["Cache Read", formatNumber(stats.cacheReadTokens)],
    ["Cache Write", formatNumber(stats.cacheWriteTokens)],
    ["Reasoning", formatNumber(stats.reasoningTokens)],
    ["Projects", stats.projects.toString()],
    ["Models Used", stats.models.toString()],
    ["Providers", stats.providers.toString()],
    ["Active Days", stats.activeDays.toString()],
    ["Longest Streak", stats.longestStreak.toString()]
  );
  console.log(table.toString());
}

export function printSummaryTables(command: string, summary: TokmeterSummary): void {
  if (summary.stats.totalRecords === 0) {
    console.log("No token usage data found.");
    console.log("\nMake sure you have session files from supported AI coding agents:");
    console.log("  Claude Code: ~/.claude/projects/");
    console.log("  OpenCode: ~/.local/share/opencode/");
    console.log("  Codex CLI: ~/.codex/sessions/");
    console.log("  Gemini CLI: ~/.gemini/tmp/");
    console.log("  and more... Run `tokmeter --help` for all supported platforms.");
    return;
  }

  switch (command) {
    case "models":
      renderModelsTable(summary.models);
      break;
    case "daily":
      renderDailyTable(summary.daily);
      break;
    case "projects":
      renderProjectsTable(summary.projects);
      break;
    case "stats":
      renderStats(summary.stats);
      break;
    default: {
      const stats = summary.stats;
      renderProjectsTable(summary.projects);
      console.log(
        `\nTotal: ${formatNumber(stats.totalTokens)} tokens | ${formatCost(stats.totalCost)} | ${stats.activeDays} active days`
      );
    }
  }
}
