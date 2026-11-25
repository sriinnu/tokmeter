/**
 * Overview & forecasting MCP tools: pulse, models, providers, projects, timeline, forecast.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  barChart,
  fmtCost,
  fmtDate,
  fmtNum,
  fmtPct,
  formatTable,
  getScopedView,
  header,
  noDataMessage,
  ProjectFilter,
  ProvidersArray,
  READ_ONLY_TOOL,
  ResultLimit,
  ScopeEnum,
  separator,
  sparkline,
  viewFooter,
} from "./context.js";

/** Register overview & forecast tools (1-6) on the MCP server. */
export function registerOverviewTools(server: McpServer): void {
  // ────────────────────────────────────────────
  // 1. tokmeter_pulse — Quick snapshot
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_pulse",
    "Get a quick pulse-check snapshot of token usage — total cost, tokens, active models, projects, and providers. " +
      "Use this as the default first tool to understand overall AI agent spending. Supports today/week/month/all scopes.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const { stats, daily } = view;

      if (stats.totalRecords === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const costValues = daily.map((d) => d.cost);
      const tokenValues = daily.map((d) => d.totalTokens);

      const lines = [
        header("PULSE"),
        `  Scope: ${view.label}${params.project ? ` │ Project: ${params.project}` : ""}${params.providers?.length ? ` │ Providers: ${params.providers.join(", ")}` : ""}`,
        separator(),
        "",
        `  💰 Total Cost       ${fmtCost(stats.totalCost)}`,
        `  📊 Total Tokens     ${fmtNum(stats.totalTokens)}`,
        `     ├─ Input          ${fmtNum(stats.inputTokens)}`,
        `     ├─ Output         ${fmtNum(stats.outputTokens)}`,
        `     ├─ Cache Read     ${fmtNum(stats.cacheReadTokens)}`,
        `     ├─ Cache Write    ${fmtNum(stats.cacheWriteTokens)}`,
        `     └─ Reasoning      ${fmtNum(stats.reasoningTokens)}`,
        "",
        `  📦 Records          ${fmtNum(stats.totalRecords)}`,
        `  🗂️  Projects         ${stats.projects}`,
        `  🤖 Models           ${stats.models}`,
        `  🔌 Providers        ${stats.providers}`,
        `  📅 Active Days      ${stats.activeDays}`,
        `  🔥 Longest Streak   ${stats.longestStreak} days`,
        `  📆 First Used       ${fmtDate(stats.firstUsed)}`,
        `  📆 Last Used        ${fmtDate(stats.lastUsed)}`,
        "",
        `  Cost Trend   ${sparkline(costValues)}`,
        `  Token Trend  ${sparkline(tokenValues)}`,
        "",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 2. tokmeter_models — Per-model breakdown
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_models",
    "Detailed per-model cost and token breakdown with visual bar charts. " +
      "Shows every model used, its provider, total tokens, cost, and share of total spend. " +
      "Use this to identify which models are driving cost.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      limit: ResultLimit.describe("Max models to show (default: 20)"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const models = view.models;

      if (models.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const limit = params.limit ?? 20;
      const shown = models.slice(0, limit);
      const maxCost = shown[0]?.cost ?? 0;

      const lines = [
        header("MODELS"),
        `  Scope: ${view.label}  │  ${models.length} model(s) found`,
        separator(),
        "",
      ];

      for (const m of shown) {
        const bar = barChart(m.cost, maxCost, 20);
        lines.push(
          `  ${m.model}`,
          `    Provider: ${m.provider}  │  Cost: ${fmtCost(m.cost)}  │  Share: ${fmtPct(m.percentageOfTotal)}`,
          `    Tokens: ${fmtNum(m.totalTokens)}  (in: ${fmtNum(m.inputTokens)} │ out: ${fmtNum(m.outputTokens)} │ cache: ${fmtNum(m.cacheReadTokens)} │ reason: ${fmtNum(m.reasoningTokens)})`,
          `    ${bar}  ${fmtCost(m.cost)}`,
          ""
        );
      }

      if (models.length > limit) {
        lines.push(`  ... and ${models.length - limit} more model(s). Increase limit to see all.`);
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 3. tokmeter_providers — Provider comparison
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_providers",
    "Compare token usage across providers (Claude Code, Cursor, Codex, Gemini, etc.). " +
      "Shows cost, tokens, model count, and share for each provider. " +
      "Use this to understand which AI coding agents are most used and costly.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const providers = view.providers;

      if (providers.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const maxCost = providers[0]?.cost ?? 0;

      const lines = [
        header("PROVIDERS"),
        `  Scope: ${view.label}  │  ${providers.length} provider(s)`,
        separator(),
        "",
      ];

      for (const p of providers) {
        const bar = barChart(p.cost, maxCost, 20);
        lines.push(
          `  ${p.provider.toUpperCase()}`,
          `    Cost: ${fmtCost(p.cost)}  │  Share: ${fmtPct(p.percentageOfTotal)}  │  Tokens: ${fmtNum(p.totalTokens)}`,
          `    Models: ${p.models.join(", ")}`,
          `    ${bar}  ${fmtCost(p.cost)}`,
          ""
        );
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 4. tokmeter_projects — Project breakdown
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_projects",
    "Show per-project token usage breakdown — cost, tokens, active days, models used, and date range. " +
      "Use this to see which projects are consuming the most AI resources.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      limit: ResultLimit.describe("Max projects to show (default: 20)"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const projects = view.projects;

      if (projects.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const limit = params.limit ?? 20;
      const shown = projects.slice(0, limit);
      const totalCost = projects.reduce((s, p) => s + p.totalCost, 0);
      const maxCost = shown[0]?.totalCost ?? 0;

      const lines = [
        header("PROJECTS"),
        `  Scope: ${view.label}  │  ${projects.length} project(s)  │  Total: ${fmtCost(totalCost)}`,
        separator(),
        "",
      ];

      for (const p of shown) {
        const share = totalCost > 0 ? (p.totalCost / totalCost) * 100 : 0;
        const bar = barChart(p.totalCost, maxCost, 20);
        lines.push(
          `  ${p.project}`,
          `    Cost: ${fmtCost(p.totalCost)}  │  Share: ${fmtPct(share)}  │  Tokens: ${fmtNum(p.totalTokens)}`,
          `    Active: ${p.activeDays} days  │  Models: ${p.models.length}  │  Providers: ${p.providers.length}`,
          `    Range: ${fmtDate(p.firstUsed)} → ${fmtDate(p.lastUsed)}`,
          `    ${bar}  ${fmtCost(p.totalCost)}`,
          ""
        );
      }

      if (projects.length > limit) {
        lines.push(`  ... and ${projects.length - limit} more project(s).`);
      }

      lines.push("");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 5. tokmeter_timeline — Daily timeline
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_timeline",
    "Show a day-by-day timeline of token usage with sparkline trends and daily cost/token breakdowns. " +
      "Use this to see patterns over time — spending spikes, quiet days, and usage trends.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      limit: ResultLimit.describe("Max days to show (default: 30, most recent first)"),
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const daily = view.daily;

      if (daily.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      const limit = params.limit ?? 30;
      // Most recent first for display, but sparkline is chronological
      const costSpark = sparkline(daily.map((d) => d.cost));
      const tokenSpark = sparkline(daily.map((d) => d.totalTokens));

      const shown = daily.slice(-limit).reverse(); // most recent first
      const maxCost = Math.max(...shown.map((d) => d.cost));

      const lines = [
        header("TIMELINE"),
        `  Scope: ${view.label}  │  ${daily.length} day(s) of activity`,
        "",
        `  Cost Trend:   ${costSpark}`,
        `  Token Trend:  ${tokenSpark}`,
        separator(),
        "",
      ];

      const rows = shown.map((d) => [
        d.date,
        fmtCost(d.cost),
        fmtNum(d.totalTokens),
        `${d.records}`,
        barChart(d.cost, maxCost, 15),
      ]);

      lines.push(
        formatTable(["Date", "Cost", "Tokens", "Records", ""], rows, [
          false,
          true,
          true,
          true,
          false,
        ])
      );

      lines.push("", "");
      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );

  // ────────────────────────────────────────────
  // 6. tokmeter_forecast — Cost projection
  // ────────────────────────────────────────────
  server.tool(
    "tokmeter_forecast",
    "Project future AI token costs based on historical burn rates. " +
      "Calculates daily/weekly/monthly averages and projects costs for the next 7, 30, and 90 days. " +
      "Also shows trend direction (accelerating, decelerating, or steady). Use this for budgeting.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    READ_ONLY_TOOL,
    async (params) => {
      const view = await getScopedView(params);
      const { stats, daily } = view;

      if (daily.length === 0) {
        return {
          content: [{ type: "text", text: noDataMessage(view.label) }],
        };
      }

      // Compute overall daily average
      const totalDays = daily.length;
      const avgDailyCost = stats.totalCost / totalDays;
      const avgDailyTokens = stats.totalTokens / totalDays;

      // Compute recent (last 7 days) vs older trend
      const recentDays = daily.slice(-7);
      const olderDays = daily.slice(0, -7);
      const recentAvgCost = recentDays.reduce((s, d) => s + d.cost, 0) / recentDays.length;
      const olderAvgCost =
        olderDays.length > 0
          ? olderDays.reduce((s, d) => s + d.cost, 0) / olderDays.length
          : recentAvgCost;

      // Trend detection
      let trendDirection: string;
      let trendEmoji: string;
      const trendRatio = olderAvgCost > 0 ? recentAvgCost / olderAvgCost : 1;
      if (trendRatio > 1.2) {
        trendDirection = "ACCELERATING";
        trendEmoji = "📈";
      } else if (trendRatio < 0.8) {
        trendDirection = "DECELERATING";
        trendEmoji = "📉";
      } else {
        trendDirection = "STEADY";
        trendEmoji = "➡️";
      }

      // Weighted projection: blend overall avg with recent trend
      const projectedDaily = recentAvgCost * 0.7 + avgDailyCost * 0.3;

      const lines = [
        header("FORECAST"),
        `  Scope: ${view.label}  │  Based on ${totalDays} active day(s) of data`,
        separator(),
        "",
        "  Historical Averages",
        `    Daily Cost:    ${fmtCost(avgDailyCost)}`,
        `    Weekly Cost:   ${fmtCost(avgDailyCost * 7)}`,
        `    Monthly Cost:  ${fmtCost(avgDailyCost * 30)}`,
        `    Daily Tokens:  ${fmtNum(avgDailyTokens)}`,
        "",
        "  Recent Trend (last 7 days)",
        `    Avg Daily Cost:   ${fmtCost(recentAvgCost)}`,
        `    Trend:            ${trendEmoji} ${trendDirection} (${trendRatio > 1 ? "+" : ""}${((trendRatio - 1) * 100).toFixed(1)}% vs earlier)`,
        "",
        separator(),
        "  Projected Costs (weighted blend)",
        `    Next  7 days:   ${fmtCost(projectedDaily * 7)}`,
        `    Next 30 days:   ${fmtCost(projectedDaily * 30)}`,
        `    Next 90 days:   ${fmtCost(projectedDaily * 90)}`,
        "",
        "  Projected Tokens",
        `    Next  7 days:   ${fmtNum(avgDailyTokens * 7)}`,
        `    Next 30 days:   ${fmtNum(avgDailyTokens * 30)}`,
        `    Next 90 days:   ${fmtNum(avgDailyTokens * 90)}`,
        "",
        "  ⚠ Forecasts are based on past usage patterns and assume",
        "    similar usage going forward. Actual costs may vary.",
        "",
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") + viewFooter(view) }],
      };
    }
  );
}
