/**
 * @sriinnu/drishti — MCP Server
 *
 * दृष्टि (Drishti) — "Vision" — Token usage observatory for AI coding agents.
 *
 * Exposes 20 tools via the Model Context Protocol that let AI agents and CLIs
 * query, analyze, forecast, and export token usage data collected by tokmeter.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  type ModelSummary,
  type ProviderId,
  type ProviderSummary,
  type ScanOptions,
  type TokenRecord,
  TokmeterCore,
} from "@sriinnu/tokmeter-core";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

/** Cached core instance with TTL to avoid rescanning on every tool call. */
let _cachedCore: TokmeterCore | null = null;
let _cachedRecords: TokenRecord[] = [];
let _cacheTimestamp = 0;
let _cacheOptionsKey = "";
const CORE_CACHE_TTL_MS = 5_000; // 5 seconds

/** Metadata from the last scan — surfaced in tool outputs for transparency. */
interface ScanMeta {
  recordCount: number;
  /** Number of records where pricing was unavailable (cost === 0 despite having tokens). */
  unpricedRecords: number;
  /** Model IDs that had no pricing data. */
  unpricedModels: string[];
  /** Milliseconds the scan took. */
  scanDurationMs: number;
}
let _lastScanMeta: ScanMeta = {
  recordCount: 0,
  unpricedRecords: 0,
  unpricedModels: [],
  scanDurationMs: 0,
};

function optionsKey(options?: ScanOptions): string {
  return JSON.stringify(options ?? {});
}

/** Get a core instance, reusing cached data if recent and same options. */
async function getCore(options?: ScanOptions): Promise<TokmeterCore> {
  const key = optionsKey(options);
  const now = Date.now();
  if (_cachedCore && key === _cacheOptionsKey && now - _cacheTimestamp < CORE_CACHE_TTL_MS) {
    return _cachedCore;
  }
  const scanStart = Date.now();
  const core = new TokmeterCore();
  const records = await core.scan(options);
  const scanDuration = Date.now() - scanStart;

  // Compute scan metadata for transparency
  const hasTokens = (r: TokenRecord) => r.inputTokens + r.outputTokens > 0;
  const unpriced = records.filter((r) => r.cost === 0 && hasTokens(r));
  const unpricedModels = [...new Set(unpriced.map((r) => r.model))];
  _lastScanMeta = {
    recordCount: records.length,
    unpricedRecords: unpriced.length,
    unpricedModels,
    scanDurationMs: scanDuration,
  };

  _cachedCore = core;
  _cachedRecords = records;
  _cacheTimestamp = now;
  _cacheOptionsKey = key;
  return core;
}

/** Build a transparency footer for tool outputs. */
function scanFooter(): string {
  const m = _lastScanMeta;
  const parts = [`📊 ${m.recordCount} records scanned in ${m.scanDurationMs}ms`];
  if (m.unpricedRecords > 0) {
    parts.push(
      `⚠️  ${m.unpricedRecords} records missing pricing (models: ${m.unpricedModels.join(", ")})`
    );
  }
  return `\n${separator()}\n${parts.join("\n")}`;
}

/** Build ScanOptions from the common scope/filter params many tools accept. */
function buildScanOptions(params: {
  scope?: string;
  since?: string;
  until?: string;
  project?: string;
  providers?: string[];
}): ScanOptions {
  const opts: ScanOptions = {};
  if (params.scope === "today") opts.today = true;
  else if (params.scope === "week") opts.week = true;
  else if (params.scope === "month") opts.month = true;
  // "all" or undefined means no date filter
  if (params.since) opts.since = params.since;
  if (params.until) opts.until = params.until;
  if (params.project) opts.project = params.project;
  if (params.providers && params.providers.length > 0) {
    opts.providers = params.providers as ProviderId[];
  }
  return opts;
}

/** Build a CleanupFilter from tool params (shared by preview + execute). */
function buildCleanupFilter(params: {
  project?: string;
  providers?: string[];
  since?: string;
  until?: string;
  scope?: string;
}): import("@sriinnu/tokmeter-core").CleanupFilter {
  const filter: import("@sriinnu/tokmeter-core").CleanupFilter = {};
  if (params.project) filter.project = params.project;
  if (params.providers?.length) filter.providers = params.providers as ProviderId[];
  if (params.since) filter.since = params.since;
  if (params.until) filter.until = params.until;
  if (params.scope === "today") filter.today = true;
  else if (params.scope === "week") filter.week = true;
  else if (params.scope === "month") filter.month = true;
  return filter;
}

// ── Formatting ──────────────────────────────────────────────
// These formatters are MCP-server-specific (plain text, no chalk colors).
// The shared chalk-colored formatters live in formatter.ts.

/** Unicode block characters for sparkline rendering. */
const SPARKLINE_CHARS = "▁▂▃▄▅▆▇█";

/** Render a sparkline from an array of numeric values. */
function sparkline(values: number[]): string {
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return values
    .map((v) => SPARKLINE_CHARS[Math.round(((v - min) / range) * (SPARKLINE_CHARS.length - 1))])
    .join("");
}

/** Format a USD cost with adaptive precision: $0.0012, $0.123, $4.56. */
function fmtCost(n: number): string {
  if (n === 0) return "$0.00";
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

/** Format a number compactly: 1.2B, 45.3M, 890K, 1,234. */
function fmtNum(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString("en-US");
}

/** Format a percentage to one decimal place. */
function fmtPct(n: number): string {
  return `${n.toFixed(1)}%`;
}

/** Format a timestamp as YYYY-MM-DD, or "—" for invalid/missing values. */
function fmtDate(ts: number): string {
  if (!ts || ts === Number.POSITIVE_INFINITY || ts === Number.NEGATIVE_INFINITY) return "—";
  return new Date(ts).toISOString().slice(0, 10);
}

/** Format a timestamp as YYYY-MM-DD HH:MM:SS, or "—" for invalid/missing values. */
function fmtDatetime(ts: number): string {
  if (!ts || ts === Number.POSITIVE_INFINITY || ts === Number.NEGATIVE_INFINITY) return "—";
  return new Date(ts).toISOString().slice(0, 19).replace("T", " ");
}

/** Render a filled/empty progress bar: ████░░░░ */
function progressBar(value: number, max: number, width = 20): string {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

/** Render a shaded bar chart segment: ▓▓▓▓░░░░ */
function barChart(value: number, max: number, width = 25): string {
  const ratio = max > 0 ? Math.min(value / max, 1) : 0;
  const filled = Math.round(ratio * width);
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

/** Render a दृष्टि section header with double-line borders. */
function header(title: string): string {
  return `\n═══════════════════════════════════════════════════════\n  【♾️】 ${title}\n═══════════════════════════════════════════════════════`;
}

/** Render a horizontal separator line. */
function separator(): string {
  return "───────────────────────────────────────────────────────";
}

/**
 * Format a table with auto-sized columns and optional right-alignment.
 *
 * @param headers - Column header labels.
 * @param rows - 2D array of cell values.
 * @param alignRight - Per-column right-alignment flags (default: left-align).
 */
function formatTable(headers: string[], rows: string[][], alignRight?: boolean[]): string {
  if (rows.length === 0) return "  (no data)";

  // Compute column widths
  const colWidths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] || "").length))
  );

  const pad = (s: string, w: number, right?: boolean) => (right ? s.padStart(w) : s.padEnd(w));

  const headerLine = headers.map((h, i) => pad(h, colWidths[i], alignRight?.[i])).join("  │  ");
  const divider = colWidths.map((w) => "─".repeat(w)).join("──┼──");

  const body = rows
    .map((r) => r.map((cell, i) => pad(cell || "", colWidths[i], alignRight?.[i])).join("  │  "))
    .join("\n");

  return `${headerLine}\n${divider}\n${body}`;
}

/** Convert a scope enum value to a human-readable label for display. */
function scopeLabel(scope?: string): string {
  if (scope === "today") return "Today";
  if (scope === "week") return "Last 7 Days";
  if (scope === "month") return "This Month";
  return "All Time";
}

/** Render a "no data" message when a tool finds zero records for the given scope. */
function noDataMessage(scope?: string): string {
  return `${header("NO DATA")}\n\n  No token usage records found for scope: ${scopeLabel(scope)}.\n  Make sure you have used an AI coding agent that tokmeter supports.\n`;
}

// ── Zod schemas (reused across tools) ───────────────────────

const ScopeEnum = z
  .enum(["today", "week", "month", "all"])
  .optional()
  .describe("Time scope: today, week (last 7d), month (calendar month), or all (default)");

const ProvidersArray = z
  .array(z.string())
  .optional()
  .describe("Filter to specific providers (e.g. ['claude-code','cursor'])");

const ProjectFilter = z.string().optional().describe("Filter by project name/path substring");

const SinceDate = z.string().optional().describe("Start date (YYYY-MM-DD) for custom date range");

const UntilDate = z.string().optional().describe("End date (YYYY-MM-DD) for custom date range");

// ─────────────────────────────────────────────────────────────
// Server & Tools
// ─────────────────────────────────────────────────────────────

/**
 * Create and configure the दृष्टि MCP server with all 20 tools.
 *
 * Each tool call uses {@link getCore} which caches the TokmeterCore instance
 * for 5 seconds to avoid rescanning the filesystem on rapid successive calls.
 * Every tool output includes a transparency footer showing record count,
 * scan duration, and warnings for models with missing pricing.
 *
 * @returns Configured McpServer ready to be connected to a transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({
    name: "drishti",
    version: "0.1.0",
    description: "∞ — Token usage observatory for AI coding agents",
  });

  // ────────────────────────────────────────────
  // 1. drishti_pulse — Quick snapshot
  // ────────────────────────────────────────────
  server.tool(
    "drishti_pulse",
    "Get a quick pulse-check snapshot of token usage — total cost, tokens, active models, projects, and providers. " +
      "Use this as the default first tool to understand overall AI agent spending. Supports today/week/month/all scopes.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const stats = core.getStats();

      if (stats.totalRecords === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const daily = core.getDailyBreakdown();
      const costValues = daily.map((d) => d.cost);
      const tokenValues = daily.map((d) => d.totalTokens);

      const lines = [
        header("PULSE"),
        `  Scope: ${scopeLabel(params.scope)}${params.project ? ` │ Project: ${params.project}` : ""}`,
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

      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 2. drishti_models — Per-model breakdown
  // ────────────────────────────────────────────
  server.tool(
    "drishti_models",
    "Detailed per-model cost and token breakdown with visual bar charts. " +
      "Shows every model used, its provider, total tokens, cost, and share of total spend. " +
      "Use this to identify which models are driving cost.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      limit: z.number().optional().describe("Max models to show (default: 20)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const models = core.getModelCosts({ project: params.project });

      if (models.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const limit = params.limit ?? 20;
      const shown = models.slice(0, limit);
      const maxCost = shown[0]?.cost ?? 0;

      const lines = [
        header("MODELS"),
        `  Scope: ${scopeLabel(params.scope)}  │  ${models.length} model(s) found`,
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
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 3. drishti_providers — Provider comparison
  // ────────────────────────────────────────────
  server.tool(
    "drishti_providers",
    "Compare token usage across providers (Claude Code, Cursor, Codex, Gemini, etc.). " +
      "Shows cost, tokens, model count, and share for each provider. " +
      "Use this to understand which AI coding agents are most used and costly.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const providers = core.getProviderBreakdown();

      if (providers.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const maxCost = providers[0]?.cost ?? 0;

      const lines = [
        header("PROVIDERS"),
        `  Scope: ${scopeLabel(params.scope)}  │  ${providers.length} provider(s)`,
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
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 4. drishti_projects — Project breakdown
  // ────────────────────────────────────────────
  server.tool(
    "drishti_projects",
    "Show per-project token usage breakdown — cost, tokens, active days, models used, and date range. " +
      "Use this to see which projects are consuming the most AI resources.",
    {
      scope: ScopeEnum,
      providers: ProvidersArray,
      limit: z.number().optional().describe("Max projects to show (default: 20)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const projects = core.getAllProjects().sort((a, b) => b.totalCost - a.totalCost);

      if (projects.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const limit = params.limit ?? 20;
      const shown = projects.slice(0, limit);
      const totalCost = projects.reduce((s, p) => s + p.totalCost, 0);
      const maxCost = shown[0]?.totalCost ?? 0;

      const lines = [
        header("PROJECTS"),
        `  Scope: ${scopeLabel(params.scope)}  │  ${projects.length} project(s)  │  Total: ${fmtCost(totalCost)}`,
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
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 5. drishti_timeline — Daily timeline
  // ────────────────────────────────────────────
  server.tool(
    "drishti_timeline",
    "Show a day-by-day timeline of token usage with sparkline trends and daily cost/token breakdowns. " +
      "Use this to see patterns over time — spending spikes, quiet days, and usage trends.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      limit: z.number().optional().describe("Max days to show (default: 30, most recent first)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const daily = core.getDailyBreakdown({ project: params.project });

      if (daily.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const limit = params.limit ?? 30;
      // Most recent first for display, but sparkline is chronological
      const costSpark = sparkline(daily.map((d) => d.cost));
      const tokenSpark = sparkline(daily.map((d) => d.totalTokens));

      const shown = daily.slice(-limit).reverse(); // most recent first
      const maxCost = Math.max(...shown.map((d) => d.cost));

      const lines = [
        header("TIMELINE"),
        `  Scope: ${scopeLabel(params.scope)}  │  ${daily.length} day(s) of activity`,
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
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 6. drishti_forecast — Cost projection
  // ────────────────────────────────────────────
  server.tool(
    "drishti_forecast",
    "Project future AI token costs based on historical burn rates. " +
      "Calculates daily/weekly/monthly averages and projects costs for the next 7, 30, and 90 days. " +
      "Also shows trend direction (accelerating, decelerating, or steady). Use this for budgeting.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const stats = core.getStats();
      const daily = core.getDailyBreakdown({ project: params.project });

      if (daily.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
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
        `  Scope: ${scopeLabel(params.scope)}  │  Based on ${totalDays} day(s) of data`,
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

      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 7. drishti_search — Record search
  // ────────────────────────────────────────────
  server.tool(
    "drishti_search",
    "Flexible search across all token usage records with filtering by model, provider, project, date range, and cost thresholds. " +
      "Returns individual records sorted by timestamp. Use this to find specific usage events or investigate high-cost records.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      model: z.string().optional().describe("Filter by model name substring"),
      min_cost: z.number().optional().describe("Minimum cost per record (USD)"),
      max_cost: z.number().optional().describe("Maximum cost per record (USD)"),
      since: SinceDate,
      until: UntilDate,
      sort_by: z
        .enum(["cost", "tokens", "time"])
        .optional()
        .describe("Sort by cost (desc), tokens (desc), or time (desc). Default: time"),
      limit: z.number().optional().describe("Max records to return (default: 25)"),
    },
    async (params) => {
      const opts = buildScanOptions({
        scope: params.scope,
        since: params.since,
        until: params.until,
        project: params.project,
        providers: params.providers,
      });
      const core = await getCore(opts);
      let records = core.getRecords();

      // Additional filters
      if (params.model) {
        const m = params.model.toLowerCase();
        records = records.filter((r) => r.model.toLowerCase().includes(m));
      }
      if (params.min_cost !== undefined) {
        records = records.filter((r) => r.cost >= params.min_cost!);
      }
      if (params.max_cost !== undefined) {
        records = records.filter((r) => r.cost <= params.max_cost!);
      }

      // Sort
      const sortBy = params.sort_by ?? "time";
      if (sortBy === "cost") {
        records.sort((a, b) => b.cost - a.cost);
      } else if (sortBy === "tokens") {
        records.sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens));
      } else {
        records.sort((a, b) => b.timestamp - a.timestamp);
      }

      const limit = params.limit ?? 25;
      const shown = records.slice(0, limit);

      if (records.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const lines = [
        header("SEARCH"),
        `  ${records.length} record(s) found  │  Showing top ${Math.min(limit, records.length)}  │  Sorted by: ${sortBy}`,
        separator(),
        "",
      ];

      for (const r of shown) {
        const totalTok =
          r.inputTokens +
          r.outputTokens +
          r.cacheReadTokens +
          r.cacheWriteTokens +
          r.reasoningTokens;
        lines.push(
          `  ${fmtDatetime(r.timestamp)}  │  ${r.provider}  │  ${r.model}`,
          `    Project: ${r.project}  │  Cost: ${fmtCost(r.cost)}  │  Tokens: ${fmtNum(totalTok)}`,
          `    in: ${fmtNum(r.inputTokens)} │ out: ${fmtNum(r.outputTokens)} │ cache_r: ${fmtNum(r.cacheReadTokens)} │ cache_w: ${fmtNum(r.cacheWriteTokens)} │ reason: ${fmtNum(r.reasoningTokens)}`,
          ""
        );
      }

      if (records.length > limit) {
        lines.push(
          `  ... ${records.length - limit} more record(s) not shown. Increase limit to see more.`
        );
      }

      lines.push("");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 8. drishti_compare — Side-by-side comparison
  // ────────────────────────────────────────────
  server.tool(
    "drishti_compare",
    "Compare two or more models or providers side-by-side on cost, tokens, efficiency, and usage metrics. " +
      "Use this when the user wants to know which model or provider is cheaper, more efficient, or more heavily used.",
    {
      compare_type: z
        .enum(["models", "providers", "projects"])
        .describe("What to compare: models, providers, or projects"),
      names: z
        .array(z.string())
        .optional()
        .describe("Specific names to compare (if omitted, compares top entries)"),
      scope: ScopeEnum,
      project: ProjectFilter,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);

      const lines = [
        header("COMPARE"),
        `  Comparing: ${params.compare_type}  │  Scope: ${scopeLabel(params.scope)}`,
        separator(),
        "",
      ];

      if (params.compare_type === "models") {
        let models = core.getModelCosts({ project: params.project });
        if (params.names && params.names.length > 0) {
          const nameSet = new Set(params.names.map((n) => n.toLowerCase()));
          models = models.filter(
            (m) =>
              nameSet.has(m.model.toLowerCase()) ||
              params.names!.some((n) => m.model.toLowerCase().includes(n.toLowerCase()))
          );
        } else {
          models = models.slice(0, 5);
        }

        if (models.length === 0) {
          return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
        }

        // Compute per-model metrics
        const maxTokens = Math.max(...models.map((m) => m.totalTokens));
        const maxCost = Math.max(...models.map((m) => m.cost));

        const headers = [
          "Metric",
          ...models.map((m) => (m.model.length > 25 ? `${m.model.slice(0, 22)}...` : m.model)),
        ];
        const rows: string[][] = [
          ["Provider", ...models.map((m) => m.provider)],
          ["Total Cost", ...models.map((m) => fmtCost(m.cost))],
          ["Total Tokens", ...models.map((m) => fmtNum(m.totalTokens))],
          ["Input Tokens", ...models.map((m) => fmtNum(m.inputTokens))],
          ["Output Tokens", ...models.map((m) => fmtNum(m.outputTokens))],
          ["Cache Read", ...models.map((m) => fmtNum(m.cacheReadTokens))],
          ["Reasoning", ...models.map((m) => fmtNum(m.reasoningTokens))],
          ["Cost Share", ...models.map((m) => fmtPct(m.percentageOfTotal))],
          [
            "Cost/1M tokens",
            ...models.map((m) =>
              m.totalTokens > 0 ? fmtCost((m.cost / m.totalTokens) * 1_000_000) : "—"
            ),
          ],
          [
            "Cache Hit Rate",
            ...models.map((m) => {
              const totalIn = m.inputTokens + m.cacheReadTokens;
              return totalIn > 0 ? fmtPct((m.cacheReadTokens / totalIn) * 100) : "—";
            }),
          ],
          ["Cost Bar", ...models.map((m) => barChart(m.cost, maxCost, 12))],
          ["Token Bar", ...models.map((m) => barChart(m.totalTokens, maxTokens, 12))],
        ];

        lines.push(formatTable(headers, rows));
      } else if (params.compare_type === "providers") {
        let providers = core.getProviderBreakdown();
        if (params.names && params.names.length > 0) {
          const nameSet = new Set(params.names.map((n) => n.toLowerCase()));
          providers = providers.filter(
            (p) =>
              nameSet.has(p.provider.toLowerCase()) ||
              params.names!.some((n) => p.provider.toLowerCase().includes(n.toLowerCase()))
          );
        } else {
          providers = providers.slice(0, 5);
        }

        if (providers.length === 0) {
          return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
        }

        const maxCost = Math.max(...providers.map((p) => p.cost));
        const headers = ["Metric", ...providers.map((p) => p.provider)];
        const rows: string[][] = [
          ["Total Cost", ...providers.map((p) => fmtCost(p.cost))],
          ["Total Tokens", ...providers.map((p) => fmtNum(p.totalTokens))],
          ["Cost Share", ...providers.map((p) => fmtPct(p.percentageOfTotal))],
          ["Models Used", ...providers.map((p) => `${p.models.length}`)],
          [
            "Cost/1M tokens",
            ...providers.map((p) =>
              p.totalTokens > 0 ? fmtCost((p.cost / p.totalTokens) * 1_000_000) : "—"
            ),
          ],
          ["Cost Bar", ...providers.map((p) => barChart(p.cost, maxCost, 12))],
        ];

        lines.push(formatTable(headers, rows));
      } else {
        // projects
        let projects = core.getAllProjects().sort((a, b) => b.totalCost - a.totalCost);
        if (params.names && params.names.length > 0) {
          projects = projects.filter((p) =>
            params.names!.some((n) => p.project.toLowerCase().includes(n.toLowerCase()))
          );
        } else {
          projects = projects.slice(0, 5);
        }

        if (projects.length === 0) {
          return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
        }

        const maxCost = Math.max(...projects.map((p) => p.totalCost));
        const headers = [
          "Metric",
          ...projects.map((p) =>
            p.project.length > 20 ? `...${p.project.slice(-17)}` : p.project
          ),
        ];
        const rows: string[][] = [
          ["Total Cost", ...projects.map((p) => fmtCost(p.totalCost))],
          ["Total Tokens", ...projects.map((p) => fmtNum(p.totalTokens))],
          ["Active Days", ...projects.map((p) => `${p.activeDays}`)],
          ["Models", ...projects.map((p) => `${p.models.length}`)],
          ["Providers", ...projects.map((p) => `${p.providers.length}`)],
          ["First Used", ...projects.map((p) => fmtDate(p.firstUsed))],
          ["Last Used", ...projects.map((p) => fmtDate(p.lastUsed))],
          ["Cost Bar", ...projects.map((p) => barChart(p.totalCost, maxCost, 12))],
        ];

        lines.push(formatTable(headers, rows));
      }

      lines.push("", "");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 9. drishti_export — Export data
  // ────────────────────────────────────────────
  server.tool(
    "drishti_export",
    "Export token usage data as JSON, CSV, or Markdown. " +
      "Returns the full data payload in the requested format. " +
      "Use JSON for programmatic consumption, CSV for spreadsheets, Markdown for reports.",
    {
      format: z.enum(["json", "csv", "markdown"]).describe("Export format: json, csv, or markdown"),
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      data: z
        .enum(["records", "models", "providers", "projects", "daily", "stats", "all"])
        .optional()
        .describe("Which data to export (default: all)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const dataType = params.data ?? "all";

      if (params.format === "json") {
        let payload: unknown;
        if (dataType === "all") {
          payload = core.toJSON();
        } else if (dataType === "records") {
          payload = core.getRecords();
        } else if (dataType === "models") {
          payload = core.getModelCosts({ project: params.project });
        } else if (dataType === "providers") {
          payload = core.getProviderBreakdown();
        } else if (dataType === "projects") {
          payload = core.getAllProjects();
        } else if (dataType === "daily") {
          payload = core.getDailyBreakdown({ project: params.project });
        } else if (dataType === "stats") {
          payload = core.getStats();
        }
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      }

      if (params.format === "csv") {
        let csv: string;
        if (dataType === "records" || dataType === "all") {
          const records = core.getRecords();
          const csvHeaders = [
            "timestamp",
            "date",
            "project",
            "provider",
            "model",
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
            "cost",
          ];
          const csvRows = records.map((r) =>
            [
              r.timestamp,
              new Date(r.timestamp).toISOString(),
              `"${r.project}"`,
              r.provider,
              `"${r.model}"`,
              r.inputTokens,
              r.outputTokens,
              r.cacheReadTokens,
              r.cacheWriteTokens,
              r.reasoningTokens,
              r.cost.toFixed(6),
            ].join(",")
          );
          csv = [csvHeaders.join(","), ...csvRows].join("\n");
        } else if (dataType === "models") {
          const models = core.getModelCosts({ project: params.project });
          const csvHeaders = [
            "model",
            "provider",
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
            "totalTokens",
            "cost",
            "percentageOfTotal",
          ];
          const csvRows = models.map((m) =>
            [
              `"${m.model}"`,
              m.provider,
              m.inputTokens,
              m.outputTokens,
              m.cacheReadTokens,
              m.cacheWriteTokens,
              m.reasoningTokens,
              m.totalTokens,
              m.cost.toFixed(6),
              m.percentageOfTotal.toFixed(2),
            ].join(",")
          );
          csv = [csvHeaders.join(","), ...csvRows].join("\n");
        } else if (dataType === "daily") {
          const daily = core.getDailyBreakdown({ project: params.project });
          const csvHeaders = [
            "date",
            "totalTokens",
            "inputTokens",
            "outputTokens",
            "cacheReadTokens",
            "cacheWriteTokens",
            "reasoningTokens",
            "cost",
            "records",
          ];
          const csvRows = daily.map((d) =>
            [
              d.date,
              d.totalTokens,
              d.inputTokens,
              d.outputTokens,
              d.cacheReadTokens,
              d.cacheWriteTokens,
              d.reasoningTokens,
              d.cost.toFixed(6),
              d.records,
            ].join(",")
          );
          csv = [csvHeaders.join(","), ...csvRows].join("\n");
        } else {
          csv = `# Unsupported CSV export for data type: ${dataType}. Use 'records', 'models', or 'daily'.`;
        }
        return { content: [{ type: "text", text: csv }] };
      }

      // Markdown
      if (params.format === "markdown") {
        const stats = core.getStats();
        const models = core.getModelCosts({ project: params.project });
        const providers = core.getProviderBreakdown();
        const daily = core.getDailyBreakdown({ project: params.project });

        const md: string[] = [
          "# 【♾️】 Token Usage Report",
          "",
          `**Scope:** ${scopeLabel(params.scope)}${params.project ? ` | **Project:** ${params.project}` : ""}`,
          `**Generated:** ${new Date().toISOString().slice(0, 19)}`,
          "",
          "## Summary",
          "",
          "| Metric | Value |",
          "|--------|-------|",
          `| Total Cost | ${fmtCost(stats.totalCost)} |`,
          `| Total Tokens | ${fmtNum(stats.totalTokens)} |`,
          `| Records | ${fmtNum(stats.totalRecords)} |`,
          `| Projects | ${stats.projects} |`,
          `| Models | ${stats.models} |`,
          `| Providers | ${stats.providers} |`,
          `| Active Days | ${stats.activeDays} |`,
          "",
          "## Models",
          "",
          "| Model | Provider | Cost | Tokens | Share |",
          "|-------|----------|------|--------|-------|",
          ...models.map(
            (m) =>
              `| ${m.model} | ${m.provider} | ${fmtCost(m.cost)} | ${fmtNum(m.totalTokens)} | ${fmtPct(m.percentageOfTotal)} |`
          ),
          "",
          "## Providers",
          "",
          "| Provider | Cost | Tokens | Share |",
          "|----------|------|--------|-------|",
          ...providers.map(
            (p) =>
              `| ${p.provider} | ${fmtCost(p.cost)} | ${fmtNum(p.totalTokens)} | ${fmtPct(p.percentageOfTotal)} |`
          ),
          "",
          "## Daily Breakdown",
          "",
          "| Date | Cost | Tokens | Records |",
          "|------|------|--------|---------|",
          ...daily
            .slice(-30)
            .map(
              (d) => `| ${d.date} | ${fmtCost(d.cost)} | ${fmtNum(d.totalTokens)} | ${d.records} |`
            ),
          "",
        ];

        return { content: [{ type: "text", text: md.join("\n") }] };
      }

      return { content: [{ type: "text", text: "Unknown format." }] };
    }
  );

  // ────────────────────────────────────────────
  // 10. drishti_budget — Budget monitoring
  // ────────────────────────────────────────────
  server.tool(
    "drishti_budget",
    "Monitor spending against a budget with visual progress bars and alerts. " +
      "Set a daily, weekly, or monthly budget and see how close you are to the limit. " +
      "Shows projected overshoot/undershoot. Use this to stay within spending targets.",
    {
      daily_budget: z.number().optional().describe("Daily budget in USD"),
      weekly_budget: z.number().optional().describe("Weekly budget in USD"),
      monthly_budget: z.number().optional().describe("Monthly budget in USD"),
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    async (params) => {
      if (!params.daily_budget && !params.weekly_budget && !params.monthly_budget) {
        return {
          content: [
            {
              type: "text",
              text: `${header("BUDGET")}\n\n  ⚠ Please provide at least one budget: daily_budget, weekly_budget, or monthly_budget.\n`,
            },
          ],
        };
      }

      const lines = [header("BUDGET"), separator(), ""];

      // Today
      if (params.daily_budget) {
        const core = await getCore(
          buildScanOptions({
            scope: "today",
            project: params.project,
            providers: params.providers,
          })
        );
        const stats = core.getStats();
        const spent = stats.totalCost;
        const budget = params.daily_budget;
        const pct = budget > 0 ? (spent / budget) * 100 : 0;
        const remaining = budget - spent;
        const bar = progressBar(spent, budget, 30);
        const status = pct >= 100 ? "🔴 OVER BUDGET" : pct >= 80 ? "🟡 WARNING" : "🟢 ON TRACK";

        lines.push(
          `  Daily Budget: ${fmtCost(budget)}`,
          `    Spent:     ${fmtCost(spent)}  │  ${fmtPct(pct)} used  │  ${status}`,
          `    Remaining: ${remaining >= 0 ? fmtCost(remaining) : `-${fmtCost(Math.abs(remaining))}`}`,
          `    ${bar}`,
          ""
        );
      }

      // This week
      if (params.weekly_budget) {
        const core = await getCore(
          buildScanOptions({
            scope: "week",
            project: params.project,
            providers: params.providers,
          })
        );
        const stats = core.getStats();
        const spent = stats.totalCost;
        const budget = params.weekly_budget;
        const pct = budget > 0 ? (spent / budget) * 100 : 0;
        const remaining = budget - spent;
        const bar = progressBar(spent, budget, 30);
        const status = pct >= 100 ? "🔴 OVER BUDGET" : pct >= 80 ? "🟡 WARNING" : "🟢 ON TRACK";

        // Days elapsed in week for projection
        const dayOfWeek = new Date().getDay() || 7; // 1-7
        const projectedWeekly = (spent / dayOfWeek) * 7;

        lines.push(
          `  Weekly Budget: ${fmtCost(budget)}  (Day ${dayOfWeek}/7)`,
          `    Spent:      ${fmtCost(spent)}  │  ${fmtPct(pct)} used  │  ${status}`,
          `    Remaining:  ${remaining >= 0 ? fmtCost(remaining) : `-${fmtCost(Math.abs(remaining))}`}`,
          `    Projected:  ${fmtCost(projectedWeekly)} by end of week ${projectedWeekly > budget ? "⚠ WILL EXCEED" : "✓ within budget"}`,
          `    ${bar}`,
          ""
        );
      }

      // This month
      if (params.monthly_budget) {
        const core = await getCore(
          buildScanOptions({
            scope: "month",
            project: params.project,
            providers: params.providers,
          })
        );
        const stats = core.getStats();
        const spent = stats.totalCost;
        const budget = params.monthly_budget;
        const pct = budget > 0 ? (spent / budget) * 100 : 0;
        const remaining = budget - spent;
        const bar = progressBar(spent, budget, 30);
        const status = pct >= 100 ? "🔴 OVER BUDGET" : pct >= 80 ? "🟡 WARNING" : "🟢 ON TRACK";

        // Days elapsed/remaining in month for projection
        const now = new Date();
        const dayOfMonth = now.getDate();
        const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        const projectedMonthly = (spent / dayOfMonth) * daysInMonth;

        lines.push(
          `  Monthly Budget: ${fmtCost(budget)}  (Day ${dayOfMonth}/${daysInMonth})`,
          `    Spent:       ${fmtCost(spent)}  │  ${fmtPct(pct)} used  │  ${status}`,
          `    Remaining:   ${remaining >= 0 ? fmtCost(remaining) : `-${fmtCost(Math.abs(remaining))}`}`,
          `    Projected:   ${fmtCost(projectedMonthly)} by end of month ${projectedMonthly > budget ? "⚠ WILL EXCEED" : "✓ within budget"}`,
          `    ${bar}`,
          ""
        );
      }

      lines.push("");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 11. drishti_heatmap — Activity heatmap
  // ────────────────────────────────────────────
  server.tool(
    "drishti_heatmap",
    "Visualize activity patterns as a heatmap — see which hours of the day and days of the week have the heaviest usage. " +
      "Shows both cost and token intensity. Use this to understand work patterns and peak usage times.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      metric: z
        .enum(["cost", "tokens", "records"])
        .optional()
        .describe("Heatmap metric: cost, tokens, or records (default: cost)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const records = core.getRecords();

      if (records.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const metric = params.metric ?? "cost";

      // Build hour-of-day x day-of-week matrix
      const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const heatChars = " ░▒▓█";

      // hourly[hour][dayOfWeek] = accumulated metric
      const hourly: number[][] = Array.from({ length: 24 }, () => Array(7).fill(0));
      // dayTotals[dayOfWeek] and hourTotals[hour]
      const dayTotals: number[] = Array(7).fill(0);
      const hourTotals: number[] = Array(24).fill(0);

      for (const r of records) {
        const d = new Date(r.timestamp);
        const hour = d.getHours();
        const day = d.getDay();
        let value: number;
        if (metric === "cost") value = r.cost;
        else if (metric === "tokens")
          value =
            r.inputTokens +
            r.outputTokens +
            r.cacheReadTokens +
            r.cacheWriteTokens +
            r.reasoningTokens;
        else value = 1; // record count

        hourly[hour][day] += value;
        dayTotals[day] += value;
        hourTotals[hour] += value;
      }

      // Find global max for normalization
      let globalMax = 0;
      for (let h = 0; h < 24; h++) {
        for (let d = 0; d < 7; d++) {
          if (hourly[h][d] > globalMax) globalMax = hourly[h][d];
        }
      }

      const metricLabel = metric === "cost" ? "Cost" : metric === "tokens" ? "Tokens" : "Records";

      const lines = [
        header("HEATMAP"),
        `  Scope: ${scopeLabel(params.scope)}  │  Metric: ${metricLabel}  │  ${records.length} records`,
        separator(),
        "",
        "  Hour-of-Day × Day-of-Week Heatmap",
        `  Intensity: ${heatChars
          .split("")
          .map((c, i) => `${c}${i === 0 ? "=none" : ""}`)
          .join(" ")}`,
        "",
      ];

      // Header row
      lines.push(`        ${DAYS.map((d) => d.padStart(4)).join("")}`);

      // Each hour row
      for (let h = 0; h < 24; h++) {
        const hourLabel = `${String(h).padStart(2, "0")}:00`;
        const cells = DAYS.map((_, d) => {
          const val = hourly[h][d];
          const intensity =
            globalMax > 0 ? Math.round((val / globalMax) * (heatChars.length - 1)) : 0;
          return ` ${heatChars[intensity]}${heatChars[intensity]} `;
        });
        lines.push(`  ${hourLabel}  ${cells.join("")}`);
      }

      // Day-of-week summary
      lines.push("", separator(), "  Busiest Days:");
      const sortedDays = DAYS.map((name, i) => ({ name, total: dayTotals[i] })).sort(
        (a, b) => b.total - a.total
      );
      const maxDay = sortedDays[0]?.total ?? 0;
      for (const d of sortedDays) {
        if (d.total === 0) continue;
        lines.push(
          `    ${d.name}  ${barChart(d.total, maxDay, 15)}  ${metric === "cost" ? fmtCost(d.total) : fmtNum(d.total)}`
        );
      }

      // Hour summary
      lines.push("", "  Busiest Hours:");
      const sortedHours = hourTotals
        .map((total, hour) => ({ hour, total }))
        .sort((a, b) => b.total - a.total)
        .slice(0, 6);
      const maxHour = sortedHours[0]?.total ?? 0;
      for (const h of sortedHours) {
        if (h.total === 0) continue;
        lines.push(
          `    ${String(h.hour).padStart(2, "0")}:00  ${barChart(h.total, maxHour, 15)}  ${metric === "cost" ? fmtCost(h.total) : fmtNum(h.total)}`
        );
      }

      lines.push("", "");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 12. drishti_anomaly — Anomaly detection
  // ────────────────────────────────────────────
  server.tool(
    "drishti_anomaly",
    "Detect unusual spending patterns and anomalies in token usage. " +
      "Identifies days or sessions with cost spikes, sudden model switches, abnormally large requests, " +
      "and deviation from historical averages. Use this to catch runaway costs or unexpected usage.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
      sensitivity: z
        .enum(["low", "medium", "high"])
        .optional()
        .describe("Anomaly detection sensitivity (default: medium)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const records = core.getRecords();
      const daily = core.getDailyBreakdown({ project: params.project });

      if (daily.length < 2) {
        return {
          content: [
            {
              type: "text",
              text: `${header("ANOMALY")}\n\n  ⚠ Need at least 2 days of data for anomaly detection.\n`,
            },
          ],
        };
      }

      const sensitivity = params.sensitivity ?? "medium";
      const thresholds: Record<string, number> = {
        low: 3.0,
        medium: 2.0,
        high: 1.5,
      };
      const zThreshold = thresholds[sensitivity];

      const lines = [
        header("ANOMALY"),
        `  Scope: ${scopeLabel(params.scope)}  │  Sensitivity: ${sensitivity} (z > ${zThreshold})`,
        separator(),
        "",
      ];

      // ── Daily cost anomalies (z-score) ──
      const costs = daily.map((d) => d.cost);
      const mean = costs.reduce((s, c) => s + c, 0) / costs.length;
      const variance = costs.reduce((s, c) => s + (c - mean) ** 2, 0) / costs.length;
      const stddev = Math.sqrt(variance);

      const dailyAnomalies: Array<{
        date: string;
        cost: number;
        zScore: number;
        direction: string;
      }> = [];

      if (stddev > 0) {
        for (const d of daily) {
          const z = (d.cost - mean) / stddev;
          if (Math.abs(z) >= zThreshold) {
            dailyAnomalies.push({
              date: d.date,
              cost: d.cost,
              zScore: z,
              direction: z > 0 ? "SPIKE" : "DROP",
            });
          }
        }
      }

      lines.push(`  📊 Daily Cost Anomalies (mean: ${fmtCost(mean)}, stddev: ${fmtCost(stddev)})`);
      if (dailyAnomalies.length === 0) {
        lines.push("    ✓ No anomalous days detected.", "");
      } else {
        for (const a of dailyAnomalies.sort((x, y) => Math.abs(y.zScore) - Math.abs(x.zScore))) {
          const emoji = a.direction === "SPIKE" ? "🔴" : "🔵";
          lines.push(
            `    ${emoji} ${a.date}  │  ${a.direction}  │  Cost: ${fmtCost(a.cost)}  │  z-score: ${a.zScore > 0 ? "+" : ""}${a.zScore.toFixed(2)}  │  ${fmtPct(((a.cost - mean) / mean) * 100)} from mean`
          );
        }
        lines.push("");
      }

      // ── Unusually expensive individual records ──
      if (records.length > 0) {
        const recordCosts = records.map((r) => r.cost);
        const recMean = recordCosts.reduce((s, c) => s + c, 0) / records.length;
        const recVariance =
          recordCosts.reduce((s, c) => s + (c - recMean) ** 2, 0) / records.length;
        const recStddev = Math.sqrt(recVariance);

        const expensiveRecords =
          recStddev > 0
            ? records
                .map((r) => ({ ...r, zScore: (r.cost - recMean) / recStddev }))
                .filter((r) => r.zScore >= zThreshold)
                .sort((a, b) => b.zScore - a.zScore)
                .slice(0, 10)
            : [];

        lines.push(`  💸 Unusually Expensive Requests (mean: ${fmtCost(recMean)}/request)`);
        if (expensiveRecords.length === 0) {
          lines.push("    ✓ No outlier requests detected.", "");
        } else {
          for (const r of expensiveRecords) {
            lines.push(
              `    🔴 ${fmtDatetime(r.timestamp)}  │  ${r.model}  │  Cost: ${fmtCost(r.cost)}  │  z: +${r.zScore.toFixed(2)}`,
              `       Project: ${r.project}  │  Tokens: in=${fmtNum(r.inputTokens)} out=${fmtNum(r.outputTokens)}`
            );
          }
          lines.push("");
        }
      }

      // ── Sudden model change detection ──
      const dailyModels = new Map<string, Set<string>>();
      for (const r of records) {
        const date = new Date(r.timestamp).toISOString().slice(0, 10);
        if (!dailyModels.has(date)) dailyModels.set(date, new Set());
        dailyModels.get(date)!.add(r.model);
      }
      const sortedDates = [...dailyModels.keys()].sort();
      const modelChanges: Array<{ date: string; newModels: string[]; removedModels: string[] }> =
        [];
      for (let i = 1; i < sortedDates.length; i++) {
        const prev = dailyModels.get(sortedDates[i - 1])!;
        const curr = dailyModels.get(sortedDates[i])!;
        const newModels = [...curr].filter((m) => !prev.has(m));
        const removedModels = [...prev].filter((m) => !curr.has(m));
        if (newModels.length > 0 || removedModels.length > 0) {
          modelChanges.push({ date: sortedDates[i], newModels, removedModels });
        }
      }

      lines.push("  🔄 Model Change Events (last 5):");
      if (modelChanges.length === 0) {
        lines.push("    ✓ Consistent model usage across all days.", "");
      } else {
        for (const mc of modelChanges.slice(-5)) {
          if (mc.newModels.length > 0) {
            lines.push(`    📥 ${mc.date}: New → ${mc.newModels.join(", ")}`);
          }
          if (mc.removedModels.length > 0) {
            lines.push(`    📤 ${mc.date}: Dropped → ${mc.removedModels.join(", ")}`);
          }
        }
        lines.push("");
      }

      // ── Day-over-day velocity ──
      if (daily.length >= 3) {
        const velocities: Array<{ date: string; change: number; pctChange: number }> = [];
        for (let i = 1; i < daily.length; i++) {
          const prev = daily[i - 1].cost;
          const curr = daily[i].cost;
          const change = curr - prev;
          const pctChange = prev > 0 ? (change / prev) * 100 : 0;
          if (Math.abs(pctChange) > 100) {
            velocities.push({ date: daily[i].date, change, pctChange });
          }
        }

        lines.push("  ⚡ Day-over-Day Velocity Spikes (>100% change):");
        if (velocities.length === 0) {
          lines.push("    ✓ No extreme day-over-day changes.", "");
        } else {
          for (const v of velocities.slice(-5)) {
            const emoji = v.change > 0 ? "📈" : "📉";
            lines.push(
              `    ${emoji} ${v.date}  │  ${v.change > 0 ? "+" : ""}${fmtCost(v.change)}  │  ${v.pctChange > 0 ? "+" : ""}${v.pctChange.toFixed(0)}%`
            );
          }
          lines.push("");
        }
      }

      lines.push("");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 13. drishti_efficiency — Cache & efficiency metrics
  // ────────────────────────────────────────────
  server.tool(
    "drishti_efficiency",
    "Analyze cache hit rates, reasoning token ratios, input/output efficiency, and cost-per-token metrics. " +
      "Shows how efficiently AI agents are using tokens — high cache rates mean less wasted compute. " +
      "Use this to optimize costs by identifying models or projects with poor cache utilization.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const stats = core.getStats();
      const models = core.getModelCosts({ project: params.project });

      if (stats.totalRecords === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      // Global efficiency metrics
      const totalInput = stats.inputTokens + stats.cacheReadTokens;
      const cacheHitRate = totalInput > 0 ? (stats.cacheReadTokens / totalInput) * 100 : 0;
      const totalAll = stats.totalTokens;
      const reasoningRatio = totalAll > 0 ? (stats.reasoningTokens / totalAll) * 100 : 0;
      const outputRatio = totalAll > 0 ? (stats.outputTokens / totalAll) * 100 : 0;
      const costPerMillionTokens = totalAll > 0 ? (stats.totalCost / totalAll) * 1_000_000 : 0;
      const avgCostPerRecord = stats.totalRecords > 0 ? stats.totalCost / stats.totalRecords : 0;
      const inputOutputRatio = stats.outputTokens > 0 ? stats.inputTokens / stats.outputTokens : 0;

      // Cost savings from caching (estimated: cache reads cost ~90% less than fresh input)
      const estimatedCacheSavings =
        stats.cacheReadTokens > 0
          ? (stats.cacheReadTokens / 1_000_000) * costPerMillionTokens * 0.9
          : 0;

      const lines = [
        header("EFFICIENCY"),
        `  Scope: ${scopeLabel(params.scope)}`,
        separator(),
        "",
        "  Overall Metrics",
        `    Cache Hit Rate:        ${fmtPct(cacheHitRate)}  ${progressBar(cacheHitRate, 100, 20)}`,
        `    Reasoning Ratio:       ${fmtPct(reasoningRatio)}  ${progressBar(reasoningRatio, 100, 20)}`,
        `    Output Ratio:          ${fmtPct(outputRatio)}  ${progressBar(outputRatio, 100, 20)}`,
        `    Input:Output Ratio:    ${inputOutputRatio.toFixed(2)}:1`,
        `    Cost / 1M tokens:      ${fmtCost(costPerMillionTokens)}`,
        `    Avg Cost / Request:    ${fmtCost(avgCostPerRecord)}`,
        `    Est. Cache Savings:    ~${fmtCost(estimatedCacheSavings)}`,
        "",
        separator(),
        "  Per-Model Efficiency",
        "",
      ];

      // Per-model efficiency table
      const modelHeaders = ["Model", "Cache%", "Reason%", "$/1M tok", "Avg $/req"];
      const modelRows: string[][] = [];

      for (const m of models.slice(0, 15)) {
        const mTotalIn = m.inputTokens + m.cacheReadTokens;
        const mCacheRate = mTotalIn > 0 ? (m.cacheReadTokens / mTotalIn) * 100 : 0;
        const mReasonRate = m.totalTokens > 0 ? (m.reasoningTokens / m.totalTokens) * 100 : 0;
        const mCostPer1M = m.totalTokens > 0 ? (m.cost / m.totalTokens) * 1_000_000 : 0;
        // Approximate requests: total records for this model
        const modelRecords = core.getRecords().filter((r) => r.model === m.model);
        const mAvgCost = modelRecords.length > 0 ? m.cost / modelRecords.length : 0;

        modelRows.push([
          m.model.length > 30 ? `${m.model.slice(0, 27)}...` : m.model,
          fmtPct(mCacheRate),
          fmtPct(mReasonRate),
          fmtCost(mCostPer1M),
          fmtCost(mAvgCost),
        ]);
      }

      lines.push(formatTable(modelHeaders, modelRows, [false, true, true, true, true]));

      // Efficiency recommendations
      lines.push("", separator(), "  💡 Insights", "");

      if (cacheHitRate < 20) {
        lines.push(
          "    ⚠ Low cache hit rate. Consider using longer sessions to benefit from context caching."
        );
      } else if (cacheHitRate > 60) {
        lines.push(
          "    ✓ Excellent cache utilization! Context caching is saving significant costs."
        );
      }

      if (reasoningRatio > 30) {
        lines.push(
          "    ℹ High reasoning token ratio. Models are doing extensive thinking — consider if all tasks need this."
        );
      }

      if (inputOutputRatio > 10) {
        lines.push(
          "    ⚠ Very high input:output ratio. Large prompts with small outputs may indicate overloaded context."
        );
      }

      const mostExpensiveModel = models[0];
      const cheapestModel = models[models.length - 1];
      if (mostExpensiveModel && cheapestModel && models.length > 1) {
        const expRate =
          mostExpensiveModel.totalTokens > 0
            ? (mostExpensiveModel.cost / mostExpensiveModel.totalTokens) * 1_000_000
            : 0;
        const cheapRate =
          cheapestModel.totalTokens > 0
            ? (cheapestModel.cost / cheapestModel.totalTokens) * 1_000_000
            : 0;
        if (expRate > 0 && cheapRate > 0) {
          lines.push(
            `    ℹ Most expensive: ${mostExpensiveModel.model} (${fmtCost(expRate)}/1M tok) vs cheapest: ${cheapestModel.model} (${fmtCost(cheapRate)}/1M tok)`
          );
        }
      }

      lines.push("", "");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 14. drishti_leaderboard — Rank models/providers
  // ────────────────────────────────────────────
  server.tool(
    "drishti_leaderboard",
    "Rank models and providers by various metrics: total cost, cost-efficiency (cost per 1M tokens), " +
      "total tokens, cache efficiency, reasoning usage, and output volume. " +
      "Use this to find the best value models or identify the heaviest hitters.",
    {
      rank_by: z
        .enum([
          "cost",
          "cost_efficiency",
          "tokens",
          "cache_rate",
          "reasoning_rate",
          "output_volume",
          "records",
        ])
        .optional()
        .describe("Ranking metric (default: cost)"),
      entity: z
        .enum(["models", "providers"])
        .optional()
        .describe("Rank models or providers (default: models)"),
      scope: ScopeEnum,
      project: ProjectFilter,
      limit: z.number().optional().describe("Top N to show (default: 10)"),
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const rankBy = params.rank_by ?? "cost";
      const entity = params.entity ?? "models";
      const limit = params.limit ?? 10;

      const lines = [
        header("LEADERBOARD"),
        `  Entity: ${entity}  │  Ranked by: ${rankBy}  │  Scope: ${scopeLabel(params.scope)}`,
        separator(),
        "",
      ];

      if (entity === "models") {
        const models = core.getModelCosts({ project: params.project });
        const records = core.getRecords();

        if (models.length === 0) {
          return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
        }

        // Compute derived metrics for each model
        type ModelMetrics = ModelSummary & {
          costPer1M: number;
          cacheRate: number;
          reasoningRate: number;
          recordCount: number;
        };

        const metricsMap = new Map<string, number>();
        for (const r of records) {
          metricsMap.set(r.model, (metricsMap.get(r.model) ?? 0) + 1);
        }

        const enriched: ModelMetrics[] = models.map((m) => {
          const totalIn = m.inputTokens + m.cacheReadTokens;
          return {
            ...m,
            costPer1M: m.totalTokens > 0 ? (m.cost / m.totalTokens) * 1_000_000 : 0,
            cacheRate: totalIn > 0 ? (m.cacheReadTokens / totalIn) * 100 : 0,
            reasoningRate: m.totalTokens > 0 ? (m.reasoningTokens / m.totalTokens) * 100 : 0,
            recordCount: metricsMap.get(m.model) ?? 0,
          };
        });

        // Sort by requested metric
        const sortFns: Record<string, (a: ModelMetrics, b: ModelMetrics) => number> = {
          cost: (a, b) => b.cost - a.cost,
          cost_efficiency: (a, b) => a.costPer1M - b.costPer1M, // ascending = cheaper first
          tokens: (a, b) => b.totalTokens - a.totalTokens,
          cache_rate: (a, b) => b.cacheRate - a.cacheRate,
          reasoning_rate: (a, b) => b.reasoningRate - a.reasoningRate,
          output_volume: (a, b) => b.outputTokens - a.outputTokens,
          records: (a, b) => b.recordCount - a.recordCount,
        };

        enriched.sort(sortFns[rankBy] ?? sortFns.cost);
        const shown = enriched.slice(0, limit);

        const medals = ["🥇", "🥈", "🥉"];
        const maxMetric = Math.max(
          ...shown.map((m) => {
            if (rankBy === "cost") return m.cost;
            if (rankBy === "cost_efficiency") return m.costPer1M;
            if (rankBy === "tokens") return m.totalTokens;
            if (rankBy === "cache_rate") return m.cacheRate;
            if (rankBy === "reasoning_rate") return m.reasoningRate;
            if (rankBy === "output_volume") return m.outputTokens;
            if (rankBy === "records") return m.recordCount;
            return m.cost;
          })
        );

        for (let i = 0; i < shown.length; i++) {
          const m = shown[i];
          const rank = i < 3 ? medals[i] : `#${i + 1}`;
          let metricValue: string;
          let metricRaw: number;

          if (rankBy === "cost") {
            metricValue = fmtCost(m.cost);
            metricRaw = m.cost;
          } else if (rankBy === "cost_efficiency") {
            metricValue = `${fmtCost(m.costPer1M)}/1M tok`;
            metricRaw = m.costPer1M;
          } else if (rankBy === "tokens") {
            metricValue = fmtNum(m.totalTokens);
            metricRaw = m.totalTokens;
          } else if (rankBy === "cache_rate") {
            metricValue = fmtPct(m.cacheRate);
            metricRaw = m.cacheRate;
          } else if (rankBy === "reasoning_rate") {
            metricValue = fmtPct(m.reasoningRate);
            metricRaw = m.reasoningRate;
          } else if (rankBy === "output_volume") {
            metricValue = fmtNum(m.outputTokens);
            metricRaw = m.outputTokens;
          } else if (rankBy === "records") {
            metricValue = `${m.recordCount} requests`;
            metricRaw = m.recordCount;
          } else {
            metricValue = fmtCost(m.cost);
            metricRaw = m.cost;
          }

          const bar = barChart(metricRaw, maxMetric, 15);
          lines.push(
            `  ${rank.padEnd(3)} ${m.model}`,
            `      ${bar}  ${metricValue}  │  Provider: ${m.provider}  │  Total: ${fmtCost(m.cost)}`,
            ""
          );
        }
      } else {
        // providers
        const providers = core.getProviderBreakdown();
        const records = core.getRecords();

        if (providers.length === 0) {
          return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
        }

        type ProviderMetrics = ProviderSummary & {
          costPer1M: number;
          recordCount: number;
        };

        const provRecordCounts = new Map<string, number>();
        for (const r of records) {
          provRecordCounts.set(r.provider, (provRecordCounts.get(r.provider) ?? 0) + 1);
        }

        const enriched: ProviderMetrics[] = providers.map((p) => ({
          ...p,
          costPer1M: p.totalTokens > 0 ? (p.cost / p.totalTokens) * 1_000_000 : 0,
          recordCount: provRecordCounts.get(p.provider) ?? 0,
        }));

        const sortFns: Record<string, (a: ProviderMetrics, b: ProviderMetrics) => number> = {
          cost: (a, b) => b.cost - a.cost,
          cost_efficiency: (a, b) => a.costPer1M - b.costPer1M,
          tokens: (a, b) => b.totalTokens - a.totalTokens,
          records: (a, b) => b.recordCount - a.recordCount,
        };

        enriched.sort(sortFns[rankBy] ?? sortFns.cost);
        const shown = enriched.slice(0, limit);
        const medals = ["🥇", "🥈", "🥉"];

        for (let i = 0; i < shown.length; i++) {
          const p = shown[i];
          const rank = i < 3 ? medals[i] : `#${i + 1}`;
          lines.push(
            `  ${rank.padEnd(3)} ${p.provider.toUpperCase()}`,
            `      Cost: ${fmtCost(p.cost)}  │  Tokens: ${fmtNum(p.totalTokens)}  │  $/1M tok: ${fmtCost(p.costPer1M)}  │  Requests: ${p.recordCount}`,
            `      Models: ${p.models.join(", ")}`,
            ""
          );
        }
      }

      lines.push("");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 15. drishti_digest — Natural language summary
  // ────────────────────────────────────────────
  server.tool(
    "drishti_digest",
    "Generate a concise natural language summary of token usage — like a daily/weekly briefing. " +
      "Highlights key stats, top spenders, notable trends, and actionable insights in prose form. " +
      "Use this when the user wants a quick narrative overview rather than tables.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const stats = core.getStats();

      if (stats.totalRecords === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const models = core.getModelCosts({ project: params.project });
      const providers = core.getProviderBreakdown();
      const projects = core.getAllProjects().sort((a, b) => b.totalCost - a.totalCost);
      const daily = core.getDailyBreakdown({ project: params.project });
      const scope = scopeLabel(params.scope);

      // Build narrative
      const lines: string[] = [header("DIGEST"), `  ${scope} Usage Summary`, separator(), ""];

      // Opening summary
      lines.push(
        `  Over ${stats.activeDays} active day(s), you have consumed ${fmtNum(stats.totalTokens)} tokens`,
        `  across ${stats.models} model(s) from ${stats.providers} provider(s), spanning`,
        `  ${stats.projects} project(s) — totaling ${fmtCost(stats.totalCost)} in cost.`,
        ""
      );

      // Top model
      if (models.length > 0) {
        const top = models[0];
        lines.push(
          `  Your most-used model is ${top.model} (via ${top.provider}), accounting`,
          `  for ${fmtPct(top.percentageOfTotal)} of total spend at ${fmtCost(top.cost)}.`
        );
        if (models.length > 1) {
          lines.push(
            `  Runner-up: ${models[1].model} at ${fmtCost(models[1].cost)} (${fmtPct(models[1].percentageOfTotal)}).`
          );
        }
        lines.push("");
      }

      // Top provider
      if (providers.length > 0) {
        const top = providers[0];
        lines.push(
          `  The dominant provider is ${top.provider} with ${fmtPct(top.percentageOfTotal)} of`,
          `  total cost and ${top.models.length} active model(s).`,
          ""
        );
      }

      // Top project
      if (projects.length > 0) {
        const top = projects[0];
        const totalCost = projects.reduce((s, p) => s + p.totalCost, 0);
        const share = totalCost > 0 ? (top.totalCost / totalCost) * 100 : 0;
        lines.push(
          `  Your most expensive project is "${top.project}" at ${fmtCost(top.totalCost)}`,
          `  (${fmtPct(share)} of total), active for ${top.activeDays} day(s).`,
          ""
        );
      }

      // Trend
      if (daily.length >= 3) {
        const recent = daily.slice(-3);
        const earlier = daily.slice(-6, -3);
        const recentAvg = recent.reduce((s, d) => s + d.cost, 0) / recent.length;
        const earlierAvg =
          earlier.length > 0 ? earlier.reduce((s, d) => s + d.cost, 0) / earlier.length : recentAvg;

        if (earlierAvg > 0) {
          const change = ((recentAvg - earlierAvg) / earlierAvg) * 100;
          if (Math.abs(change) > 10) {
            lines.push(
              `  Trend: Your recent daily spend is ${change > 0 ? "up" : "down"} ${fmtPct(Math.abs(change))}`,
              `  compared to earlier in the period (${fmtCost(recentAvg)}/day vs ${fmtCost(earlierAvg)}/day).`,
              ""
            );
          } else {
            lines.push(`  Trend: Spending is relatively stable at ~${fmtCost(recentAvg)}/day.`, "");
          }
        }
      }

      // Cache efficiency note
      const totalInput = stats.inputTokens + stats.cacheReadTokens;
      const cacheRate = totalInput > 0 ? (stats.cacheReadTokens / totalInput) * 100 : 0;
      if (cacheRate > 0) {
        lines.push(
          `  Cache utilization: ${fmtPct(cacheRate)} of input tokens are served from cache.`,
          cacheRate > 50
            ? "  Great cache efficiency — this is saving you significant money."
            : cacheRate > 20
              ? "  Moderate cache usage — longer sessions could improve this."
              : "  Low cache hit rate — consider maintaining longer sessions for better caching.",
          ""
        );
      }

      // Busiest day
      if (daily.length > 0) {
        const busiest = daily.reduce((max, d) => (d.cost > max.cost ? d : max), daily[0]);
        lines.push(
          `  Busiest day: ${busiest.date} with ${fmtCost(busiest.cost)} spent across`,
          `  ${busiest.records} request(s) and ${fmtNum(busiest.totalTokens)} tokens.`,
          ""
        );
      }

      // Sparkline footer
      const costSpark = sparkline(daily.map((d) => d.cost));
      lines.push(separator(), `  Daily Cost:  ${costSpark}`, "");

      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 16. drishti_streaks — Usage streaks & habits
  // ────────────────────────────────────────────
  server.tool(
    "drishti_streaks",
    "Analyze your AI coding habits — active day streaks, weekend vs weekday usage, session frequency, " +
      "and consistency metrics. Use this to understand how regularly and intensively you use AI coding agents.",
    {
      scope: ScopeEnum,
      project: ProjectFilter,
      providers: ProvidersArray,
    },
    async (params) => {
      const opts = buildScanOptions(params);
      const core = await getCore(opts);
      const records = core.getRecords();
      const daily = core.getDailyBreakdown({ project: params.project });
      const stats = core.getStats();

      if (daily.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.scope) }] };
      }

      const lines = [
        header("STREAKS & HABITS"),
        `  Scope: ${scopeLabel(params.scope)}`,
        separator(),
        "",
      ];

      // ── Current streak ──
      const daySet = new Set(daily.map((d) => d.date));
      const allDates = [...daySet].sort().reverse(); // most recent first

      let currentStreak = 0;
      const today = new Date().toISOString().slice(0, 10);
      let checkDate = today;
      // Check if today or yesterday is the starting point
      if (!daySet.has(today)) {
        const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
        if (daySet.has(yesterday)) {
          checkDate = yesterday;
        } else {
          checkDate = allDates[0] || today; // last active day
        }
      }

      // Count consecutive days back from checkDate
      let cursor = new Date(checkDate);
      while (daySet.has(cursor.toISOString().slice(0, 10))) {
        currentStreak++;
        cursor = new Date(cursor.getTime() - 86400000);
      }

      // ── Longest streak ──
      const sortedDates = [...daySet].sort();
      let longestStreak = 0;
      let longestStreakStart = "";
      let longestStreakEnd = "";
      let tempStreak = 1;
      let tempStart = sortedDates[0];
      for (let i = 1; i < sortedDates.length; i++) {
        const diff =
          (new Date(sortedDates[i]).getTime() - new Date(sortedDates[i - 1]).getTime()) / 86400000;
        if (diff === 1) {
          tempStreak++;
        } else {
          if (tempStreak > longestStreak) {
            longestStreak = tempStreak;
            longestStreakStart = tempStart;
            longestStreakEnd = sortedDates[i - 1];
          }
          tempStreak = 1;
          tempStart = sortedDates[i];
        }
      }
      if (tempStreak > longestStreak) {
        longestStreak = tempStreak;
        longestStreakStart = tempStart;
        longestStreakEnd = sortedDates[sortedDates.length - 1];
      }

      lines.push(
        `  🔥 Current Streak:  ${currentStreak} day(s)`,
        `  🏆 Longest Streak:  ${longestStreak} day(s) (${longestStreakStart} → ${longestStreakEnd})`,
        `  📅 Active Days:     ${stats.activeDays}`,
        ""
      );

      // ── Date range span & coverage ──
      if (sortedDates.length >= 2) {
        const firstDate = new Date(sortedDates[0]);
        const lastDate = new Date(sortedDates[sortedDates.length - 1]);
        const spanDays = Math.round((lastDate.getTime() - firstDate.getTime()) / 86400000) + 1;
        const coverage = (stats.activeDays / spanDays) * 100;
        lines.push(
          `  📊 Date Range:      ${sortedDates[0]} → ${sortedDates[sortedDates.length - 1]} (${spanDays} days)`,
          `  📈 Coverage:        ${fmtPct(coverage)} of days active`,
          ""
        );
      }

      // ── Weekday vs weekend ──
      let weekdayCost = 0;
      let weekdayDays = 0;
      let weekendCost = 0;
      let weekendDays = 0;

      for (const d of daily) {
        const dayOfWeek = new Date(d.date).getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) {
          weekendCost += d.cost;
          weekendDays++;
        } else {
          weekdayCost += d.cost;
          weekdayDays++;
        }
      }

      const weekdayAvg = weekdayDays > 0 ? weekdayCost / weekdayDays : 0;
      const weekendAvg = weekendDays > 0 ? weekendCost / weekendDays : 0;

      lines.push(
        "  Weekday vs Weekend",
        `    Weekday:  ${weekdayDays} active day(s)  │  Avg: ${fmtCost(weekdayAvg)}/day  │  Total: ${fmtCost(weekdayCost)}`,
        `    Weekend:  ${weekendDays} active day(s)  │  Avg: ${fmtCost(weekendAvg)}/day  │  Total: ${fmtCost(weekendCost)}`,
        weekendAvg > weekdayAvg
          ? "    → You spend MORE on weekends! 🌴"
          : weekdayAvg > weekendAvg * 2
            ? "    → Weekdays are significantly heavier. 💼"
            : "    → Fairly balanced usage. ⚖️",
        ""
      );

      // ── Session intensity ──
      // Group records into sessions (records within 30 min of each other)
      const sortedRecords = [...records].sort((a, b) => a.timestamp - b.timestamp);
      let sessionCount = 0;
      let lastTs = 0;
      const SESSION_GAP = 30 * 60 * 1000; // 30 min
      for (const r of sortedRecords) {
        if (r.timestamp - lastTs > SESSION_GAP) {
          sessionCount++;
        }
        lastTs = r.timestamp;
      }

      const avgRecordsPerDay = stats.activeDays > 0 ? stats.totalRecords / stats.activeDays : 0;
      const avgSessionsPerDay = stats.activeDays > 0 ? sessionCount / stats.activeDays : 0;

      lines.push(
        "  Session Analysis (30min gap = new session)",
        `    Total Sessions:      ~${sessionCount}`,
        `    Avg Requests/Day:    ${avgRecordsPerDay.toFixed(1)}`,
        `    Avg Sessions/Day:    ${avgSessionsPerDay.toFixed(1)}`,
        `    Avg Requests/Session: ${sessionCount > 0 ? (stats.totalRecords / sessionCount).toFixed(1) : "—"}`,
        ""
      );

      // ── Weekly activity pattern (mini calendar) ──
      const weekMap = new Map<string, number>(); // ISO week -> cost
      for (const d of daily) {
        const date = new Date(d.date);
        // Approximate ISO week
        const jan1 = new Date(date.getFullYear(), 0, 1);
        const weekNum = Math.ceil(
          ((date.getTime() - jan1.getTime()) / 86400000 + jan1.getDay() + 1) / 7
        );
        const weekKey = `${date.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;
        weekMap.set(weekKey, (weekMap.get(weekKey) ?? 0) + d.cost);
      }

      const weeks = [...weekMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      if (weeks.length > 1) {
        const weekCosts = weeks.map(([, c]) => c);
        lines.push(
          `  Weekly Trend:  ${sparkline(weekCosts)}`,
          `    (${weeks.length} weeks, min: ${fmtCost(Math.min(...weekCosts))}, max: ${fmtCost(Math.max(...weekCosts))})`,
          ""
        );
      }

      lines.push("");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 17. cache_efficiency — Cache hit/miss analysis
  // ────────────────────────────────────────────
  server.tool(
    "drishti_cache_efficiency",
    "Analyze cache hit/miss patterns across sessions. Shows overall cache hit rate, dollar savings from caching, " +
      "cache write waste, and per-model breakdown. Use this to understand how effectively prompt caching is reducing your costs.",
    {
      period: z
        .enum(["today", "week", "month"])
        .optional()
        .describe("Time period to analyze: today, week, or month"),
      provider: z.string().optional().describe("Filter to a specific provider"),
      project: ProjectFilter,
    },
    async (params) => {
      const opts = buildScanOptions({
        scope: params.period,
        project: params.project,
        providers: params.provider ? [params.provider] : undefined,
      });
      const core = await getCore(opts);
      const records = core.getRecords();

      if (records.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.period) }] };
      }

      // Aggregate totals
      let totalCacheRead = 0;
      let totalCacheWrite = 0;
      let totalInputTokens = 0;

      // Per-model aggregation
      const modelMap = new Map<
        string,
        {
          cacheRead: number;
          cacheWrite: number;
          inputTokens: number;
          cost: number;
          count: number;
        }
      >();

      for (const r of records) {
        totalCacheRead += r.cacheReadTokens;
        totalCacheWrite += r.cacheWriteTokens;
        totalInputTokens += r.inputTokens;

        const existing = modelMap.get(r.model) ?? {
          cacheRead: 0,
          cacheWrite: 0,
          inputTokens: 0,
          cost: 0,
          count: 0,
        };
        existing.cacheRead += r.cacheReadTokens;
        existing.cacheWrite += r.cacheWriteTokens;
        existing.inputTokens += r.inputTokens;
        existing.cost += r.cost;
        existing.count++;
        modelMap.set(r.model, existing);
      }

      // Cache hit rate: reads / (reads + writes). If no cache activity, 0%.
      const totalCacheTokens = totalCacheRead + totalCacheWrite;
      const hitRate = totalCacheTokens > 0 ? (totalCacheRead / totalCacheTokens) * 100 : 0;

      // Estimate savings: cache reads cost ~10% of input price, so you save ~90% per cached token.
      // We approximate by looking at average input cost per token across the dataset.
      const totalCost = records.reduce((sum, r) => sum + r.cost, 0);
      const avgCostPerInputToken = totalInputTokens > 0 ? (totalCost * 0.4) / totalInputTokens : 0; // ~40% of cost is input
      const cacheSavings = totalCacheRead * avgCostPerInputToken * 0.9; // saved 90% of input price
      const cacheWaste = totalCacheWrite * avgCostPerInputToken * 0.25; // cache write premium ~25%

      // Period label
      const periodLabel =
        params.period === "today"
          ? "Today"
          : params.period === "week"
            ? "Last 7 Days"
            : params.period === "month"
              ? "This Month"
              : "All Time";

      const lines = [
        header("CACHE EFFICIENCY"),
        `  Period: ${periodLabel}${params.provider ? ` │ Provider: ${params.provider}` : ""}${params.project ? ` │ Project: ${params.project}` : ""}`,
        separator(),
        "",
        `  📊 Overall Cache Hit Rate:  ${fmtPct(hitRate)}`,
        `     ├─ Cache Reads:   ${fmtNum(totalCacheRead)} tokens`,
        `     ├─ Cache Writes:  ${fmtNum(totalCacheWrite)} tokens`,
        `     └─ Input Tokens:  ${fmtNum(totalInputTokens)} tokens`,
        "",
        `  💰 Cache Savings:   ~${fmtCost(cacheSavings)}  (what you saved vs full input price)`,
        `  🗑️  Cache Waste:     ~${fmtCost(cacheWaste)}  (premium paid on writes never amortized)`,
        `  📈 Net Benefit:     ~${fmtCost(cacheSavings - cacheWaste)}`,
        "",
      ];

      // Per-model breakdown
      const modelEntries = [...modelMap.entries()]
        .filter(([, v]) => v.cacheRead + v.cacheWrite > 0)
        .sort((a, b) => b[1].cacheRead - a[1].cacheRead);

      if (modelEntries.length > 0) {
        lines.push("  Per-Model Cache Breakdown", separator(), "");
        const tableHeaders = ["Model", "Hit Rate", "Reads", "Writes", "Calls"];
        const tableRows = modelEntries.map(([model, v]) => {
          const mTotal = v.cacheRead + v.cacheWrite;
          const mHitRate = mTotal > 0 ? (v.cacheRead / mTotal) * 100 : 0;
          return [
            model,
            fmtPct(mHitRate),
            fmtNum(v.cacheRead),
            fmtNum(v.cacheWrite),
            String(v.count),
          ];
        });
        lines.push(formatTable(tableHeaders, tableRows, [false, true, true, true, true]));
        lines.push("");
      }

      // Recommendation
      lines.push(separator(), "");
      if (hitRate >= 90) {
        lines.push(
          `  ✅ Excellent! Your cache hit rate is ${fmtPct(hitRate)} — caching saves you ~${fmtCost(cacheSavings)}/period.`,
          "     Keep conversations going to maintain high cache utilization."
        );
      } else if (hitRate >= 70) {
        lines.push(
          `  💡 Good cache usage at ${fmtPct(hitRate)}. Consider longer conversations to improve hit rates.`,
          `     Potential additional savings if you reach 90%+: ~${fmtCost(cacheSavings * 0.3)}/period.`
        );
      } else if (totalCacheTokens > 0) {
        lines.push(
          `  ⚠️  Low cache hit rate: ${fmtPct(hitRate)}. You're paying for cache writes but not reusing them.`,
          "     Try: longer conversations, fewer new sessions, and keeping context warm."
        );
      } else {
        lines.push(
          "  ℹ️  No cache activity detected. Your providers may not support prompt caching,",
          "     or caching stats aren't being reported."
        );
      }
      lines.push("");

      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 18. model_advisor — Cheaper model suggestions
  // ────────────────────────────────────────────

  /** Known pricing table (per million tokens). */
  const MODEL_PRICING: Record<string, { input: number; output: number }> = {
    opus: { input: 15, output: 75 },
    sonnet: { input: 3, output: 15 },
    haiku: { input: 0.8, output: 4 },
    "gpt-5": { input: 10, output: 30 },
    "gpt-4o": { input: 2.5, output: 10 },
    "gpt-4o-mini": { input: 0.15, output: 0.6 },
  };

  /** Match a model name to a pricing tier key. */
  function matchPricingTier(model: string): string | null {
    const lower = model.toLowerCase();
    if (lower.includes("opus")) return "opus";
    if (lower.includes("sonnet")) return "sonnet";
    if (lower.includes("haiku")) return "haiku";
    if (lower.includes("gpt-5")) return "gpt-5";
    if (lower.includes("gpt-4o-mini")) return "gpt-4o-mini";
    if (lower.includes("gpt-4o")) return "gpt-4o";
    return null;
  }

  /** Get the cheaper alternative for a model tier. */
  function cheaperAlternative(tier: string): string | null {
    const downgrades: Record<string, string> = {
      opus: "sonnet",
      sonnet: "haiku",
      "gpt-5": "gpt-4o",
      "gpt-4o": "gpt-4o-mini",
    };
    return downgrades[tier] ?? null;
  }

  server.tool(
    "drishti_model_advisor",
    "Compare what you actually spent vs what cheaper models would have cost. " +
      "Shows current spending by model and estimates savings if you downgraded expensive models " +
      "(e.g., Opus → Sonnet, GPT-5 → GPT-4o). Includes a reference pricing table.",
    {
      period: z
        .enum(["today", "week", "month"])
        .optional()
        .describe("Time period to analyze: today, week, or month"),
      project: ProjectFilter,
    },
    async (params) => {
      const opts = buildScanOptions({ scope: params.period, project: params.project });
      const core = await getCore(opts);
      const models = core.getModelCosts({ project: params.project });

      if (models.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.period) }] };
      }

      const periodLabel =
        params.period === "today"
          ? "Today"
          : params.period === "week"
            ? "Last 7 Days"
            : params.period === "month"
              ? "This Month"
              : "All Time";

      const lines = [
        header("MODEL ADVISOR"),
        `  Period: ${periodLabel}${params.project ? ` │ Project: ${params.project}` : ""}`,
        separator(),
        "",
        "  Current Spending by Model",
        separator(),
        "",
      ];

      // Current spend table
      const currentHeaders = ["Model", "Cost", "Share", "Input Tok", "Output Tok"];
      const currentRows = models
        .slice(0, 15)
        .map((m) => [
          m.model,
          fmtCost(m.cost),
          fmtPct(m.percentageOfTotal),
          fmtNum(m.inputTokens),
          fmtNum(m.outputTokens),
        ]);
      lines.push(formatTable(currentHeaders, currentRows, [false, true, true, true, true]));
      lines.push("");

      // Calculate what-if scenarios
      let totalActual = 0;
      let totalAlternative = 0;
      const scenarios: { model: string; actual: number; alternative: number; altTier: string }[] =
        [];

      for (const m of models) {
        totalActual += m.cost;
        const tier = matchPricingTier(m.model);
        if (!tier) continue;

        const altTier = cheaperAlternative(tier);
        if (!altTier) continue;

        const altPricing = MODEL_PRICING[altTier];
        if (!altPricing) continue;

        // Re-estimate cost with cheaper model pricing
        const altCost =
          (m.inputTokens / 1_000_000) * altPricing.input +
          (m.outputTokens / 1_000_000) * altPricing.output;

        totalAlternative += altCost;
        scenarios.push({ model: m.model, actual: m.cost, alternative: altCost, altTier });
      }

      // Models without a cheaper alternative still count toward the total
      const unmatched = models.filter((m) => {
        const tier = matchPricingTier(m.model);
        return !tier || !cheaperAlternative(tier);
      });
      const unmatchedCost = unmatched.reduce((s, m) => s + m.cost, 0);
      totalAlternative += unmatchedCost;

      if (scenarios.length > 0) {
        lines.push("", "  💡 What If You Downgraded?", separator(), "");

        const whatIfHeaders = ["Model", "Current", "If Downgraded", "Alt Model", "Savings"];
        const whatIfRows = scenarios.map((s) => [
          s.model,
          fmtCost(s.actual),
          fmtCost(s.alternative),
          s.altTier,
          fmtCost(s.actual - s.alternative),
        ]);
        lines.push(formatTable(whatIfHeaders, whatIfRows, [false, true, true, false, true]));

        const totalSavings = totalActual - totalAlternative;
        const savingsPct = totalActual > 0 ? (totalSavings / totalActual) * 100 : 0;

        lines.push(
          "",
          separator(),
          `  📊 Total Current Spend:     ${fmtCost(totalActual)}`,
          `  📉 Estimated w/ Downgrades: ${fmtCost(totalAlternative)}`,
          `  💰 Potential Savings:       ${fmtCost(totalSavings)} (${fmtPct(savingsPct)})`,
          ""
        );
      } else {
        lines.push(
          "",
          "  ℹ️  No downgrade scenarios available for your current models.",
          `  📊 Total Spend: ${fmtCost(totalActual)}`,
          ""
        );
      }

      // Reference pricing table
      lines.push("", "  📋 Reference Pricing (per million tokens)", separator(), "");
      const pricingHeaders = ["Model", "Input $/MTok", "Output $/MTok"];
      const pricingRows = Object.entries(MODEL_PRICING).map(([name, p]) => [
        name,
        `$${p.input.toFixed(2)}`,
        `$${p.output.toFixed(2)}`,
      ]);
      lines.push(formatTable(pricingHeaders, pricingRows, [false, true, true]));
      lines.push("");

      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 19. budget_alert — Proactive budget monitoring
  // ────────────────────────────────────────────
  server.tool(
    "drishti_budget_alert",
    "Proactive budget monitoring with configurable daily/weekly/monthly thresholds. " +
      "Shows current spend, percentage of budget used, projected end-of-period spend, and " +
      "hours remaining until budget is exceeded. Gives green/yellow/red status indicators.",
    {
      daily_budget: z.number().describe("Daily budget in USD"),
      weekly_budget: z.number().optional().describe("Weekly budget in USD"),
      monthly_budget: z.number().optional().describe("Monthly budget in USD"),
    },
    async (params) => {
      const now = new Date();
      const todayStr = now.toISOString().slice(0, 10);

      // Fetch records for each period
      const coreToday = await getCore({ today: true });
      const todayRecords = coreToday.getRecords();
      const todaySpend = todayRecords.reduce((s, r) => s + r.cost, 0);

      const coreWeek = await getCore({ week: true });
      const weekRecords = coreWeek.getRecords();
      const weekSpend = weekRecords.reduce((s, r) => s + r.cost, 0);

      const coreMonth = await getCore({ month: true });
      const monthRecords = coreMonth.getRecords();
      const monthSpend = monthRecords.reduce((s, r) => s + r.cost, 0);

      /** Determine status color based on usage percentage. */
      function budgetStatus(pct: number): string {
        if (pct >= 100) return "🔴 OVER BUDGET";
        if (pct >= 80) return "🟡 WARNING";
        return "🟢 OK";
      }

      /** Calculate hours remaining at current burn rate. */
      function hoursRemaining(
        spent: number,
        budget: number,
        _hoursInPeriod: number,
        hoursElapsed: number
      ): string {
        if (spent === 0) return "∞";
        const burnRate = spent / Math.max(hoursElapsed, 1); // $/hour
        const remaining = budget - spent;
        if (remaining <= 0) return "0.0";
        return (remaining / burnRate).toFixed(1);
      }

      // Hours elapsed today
      const hoursElapsedToday = now.getHours() + now.getMinutes() / 60;
      const hoursInDay = 24;

      // Hours elapsed this week (day of week: 0=Sun)
      const dayOfWeek = now.getDay();
      const hoursElapsedWeek = dayOfWeek * 24 + hoursElapsedToday;
      const hoursInWeek = 7 * 24;

      // Hours elapsed this month
      const dayOfMonth = now.getDate();
      const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const hoursElapsedMonth = (dayOfMonth - 1) * 24 + hoursElapsedToday;
      const hoursInMonth = daysInMonth * 24;

      // Projections based on burn rate
      const projectedDaily =
        hoursElapsedToday > 0 ? (todaySpend / hoursElapsedToday) * hoursInDay : 0;
      const projectedWeekly =
        hoursElapsedWeek > 0 ? (weekSpend / hoursElapsedWeek) * hoursInWeek : 0;
      const projectedMonthly =
        hoursElapsedMonth > 0 ? (monthSpend / hoursElapsedMonth) * hoursInMonth : 0;

      const dailyPct = (todaySpend / params.daily_budget) * 100;

      const lines = [
        header("BUDGET ALERT"),
        `  Date: ${todayStr}  │  Time: ${now.toTimeString().slice(0, 8)}`,
        separator(),
        "",
        "  📅 Daily Budget",
        `     Budget:     ${fmtCost(params.daily_budget)}`,
        `     Spent:      ${fmtCost(todaySpend)}`,
        `     Used:       ${fmtPct(dailyPct)}  ${progressBar(todaySpend, params.daily_budget)}`,
        `     Projected:  ${fmtCost(projectedDaily)} by end of day`,
        `     Status:     ${budgetStatus(dailyPct)}`,
        `     Remaining:  ${hoursRemaining(todaySpend, params.daily_budget, hoursInDay, hoursElapsedToday)} hours until budget exceeded`,
        "",
      ];

      if (params.weekly_budget) {
        const weeklyPct = (weekSpend / params.weekly_budget) * 100;
        lines.push(
          "  📅 Weekly Budget",
          `     Budget:     ${fmtCost(params.weekly_budget)}`,
          `     Spent:      ${fmtCost(weekSpend)}`,
          `     Used:       ${fmtPct(weeklyPct)}  ${progressBar(weekSpend, params.weekly_budget)}`,
          `     Projected:  ${fmtCost(projectedWeekly)} by end of week`,
          `     Status:     ${budgetStatus(weeklyPct)}`,
          `     Remaining:  ${hoursRemaining(weekSpend, params.weekly_budget, hoursInWeek, hoursElapsedWeek)} hours until budget exceeded`,
          ""
        );
      }

      if (params.monthly_budget) {
        const monthlyPct = (monthSpend / params.monthly_budget) * 100;
        lines.push(
          "  📅 Monthly Budget",
          `     Budget:     ${fmtCost(params.monthly_budget)}`,
          `     Spent:      ${fmtCost(monthSpend)}`,
          `     Used:       ${fmtPct(monthlyPct)}  ${progressBar(monthSpend, params.monthly_budget)}`,
          `     Projected:  ${fmtCost(projectedMonthly)} by end of month`,
          `     Status:     ${budgetStatus(monthlyPct)}`,
          `     Remaining:  ${hoursRemaining(monthSpend, params.monthly_budget, hoursInMonth, hoursElapsedMonth)} hours until budget exceeded`,
          ""
        );
      }

      // Cost drivers — top models from today if over budget
      if (dailyPct >= 80) {
        const modelCosts = coreToday.getModelCosts();
        if (modelCosts.length > 0) {
          lines.push(separator(), "", "  ⚡ Cost Drivers (Today)", "");
          const driverHeaders = ["Model", "Cost", "Share"];
          const driverRows = modelCosts
            .slice(0, 5)
            .map((m) => [m.model, fmtCost(m.cost), fmtPct(m.percentageOfTotal)]);
          lines.push(formatTable(driverHeaders, driverRows, [false, true, true]));
          lines.push("");
        }
      }

      lines.push("");
      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ────────────────────────────────────────────
  // 20. cost_optimization_tips — Actionable recommendations
  // ────────────────────────────────────────────
  server.tool(
    "drishti_cost_optimization_tips",
    "Analyze usage patterns and provide actionable cost optimization recommendations. " +
      "Generates tips based on actual data — cache efficiency, model selection, conversation length, " +
      "and spending distribution. Each tip includes category, severity, and estimated savings.",
    {
      period: z
        .enum(["today", "week", "month"])
        .optional()
        .describe("Time period to analyze: today, week, or month"),
    },
    async (params) => {
      const opts = buildScanOptions({ scope: params.period });
      const core = await getCore(opts);
      const records = core.getRecords();
      const models = core.getModelCosts();
      const stats = core.getStats();

      if (records.length === 0) {
        return { content: [{ type: "text", text: noDataMessage(params.period) }] };
      }

      const totalCost = stats.totalCost;

      interface Tip {
        category: string;
        severity: "info" | "warning" | "critical";
        tip: string;
        estimatedSavings: number;
      }

      const tips: Tip[] = [];

      // ── Tip 1: Cache efficiency ──
      const totalCacheRead = records.reduce((s, r) => s + r.cacheReadTokens, 0);
      const totalCacheWrite = records.reduce((s, r) => s + r.cacheWriteTokens, 0);
      const totalCacheTokens = totalCacheRead + totalCacheWrite;
      const cacheHitRate = totalCacheTokens > 0 ? (totalCacheRead / totalCacheTokens) * 100 : -1;

      if (cacheHitRate >= 0 && cacheHitRate < 80) {
        const potentialSavings = totalCost * 0.1; // ~10% savings from better caching
        tips.push({
          category: "caching",
          severity: cacheHitRate < 50 ? "critical" : "warning",
          tip: `Cache hit rate is only ${fmtPct(cacheHitRate)}. Try longer conversations instead of starting fresh sessions. Each new session discards cached context and re-sends the full prompt.`,
          estimatedSavings: potentialSavings,
        });
      }

      // ── Tip 2: Expensive model overuse ──
      const expensiveModels = models.filter((m) => {
        const tier = matchPricingTier(m.model);
        return tier === "opus" || tier === "gpt-5";
      });
      const expensiveSpend = expensiveModels.reduce((s, m) => s + m.cost, 0);
      const expensivePct = totalCost > 0 ? (expensiveSpend / totalCost) * 100 : 0;

      if (expensivePct > 50) {
        // Estimate savings by downgrading: Opus is 5x Sonnet, so ~80% savings on that portion
        const potentialSavings = expensiveSpend * 0.8;
        tips.push({
          category: "model_selection",
          severity: expensivePct > 80 ? "critical" : "warning",
          tip: `${fmtPct(expensivePct)} of your spend is on premium models (Opus/GPT-5). Consider using Sonnet or GPT-4o for routine tasks like code review, refactoring, and simple questions. Reserve Opus for complex architecture and reasoning tasks.`,
          estimatedSavings: potentialSavings,
        });
      }

      // ── Tip 3: Large input tokens (conversation bloat) ──
      const avgInputPerCall =
        records.length > 0 ? records.reduce((s, r) => s + r.inputTokens, 0) / records.length : 0;

      if (avgInputPerCall > 100_000) {
        const potentialSavings = totalCost * 0.15;
        tips.push({
          category: "conversation_length",
          severity: avgInputPerCall > 200_000 ? "critical" : "warning",
          tip: `Average input tokens per call is ${fmtNum(avgInputPerCall)} — that's large. Consider compacting conversations, using /clear or /compact, or starting fresh sessions when context gets too long. Long contexts inflate every subsequent request.`,
          estimatedSavings: potentialSavings,
        });
      }

      // ── Tip 4: Disproportionate project spending ──
      const projects = core.getAllProjects().sort((a, b) => b.totalCost - a.totalCost);
      if (projects.length >= 2) {
        const topProject = projects[0];
        const topPct = totalCost > 0 ? (topProject.totalCost / totalCost) * 100 : 0;
        if (topPct > 60) {
          tips.push({
            category: "time_of_day",
            severity: "info",
            tip: `Project "${topProject.project}" accounts for ${fmtPct(topPct)} of total spend (${fmtCost(topProject.totalCost)}). Consider whether all that usage is necessary, or if some tasks could use cheaper models or be batched more efficiently.`,
            estimatedSavings: topProject.totalCost * 0.2,
          });
        }
      }

      // ── Tip 5: No caching at all ──
      if (cacheHitRate === -1) {
        tips.push({
          category: "caching",
          severity: "info",
          tip:
            "No prompt caching activity detected. If your provider supports caching " +
            "(Claude, GPT-4o), ensure it's enabled. Prompt caching can save 80-90% on repeated context.",
          estimatedSavings: totalCost * 0.2,
        });
      }

      // ── Tip 6: High reasoning token usage ──
      const totalReasoning = records.reduce((s, r) => s + r.reasoningTokens, 0);
      const totalOutput = records.reduce((s, r) => s + r.outputTokens, 0);
      const reasoningPct = totalOutput > 0 ? (totalReasoning / totalOutput) * 100 : 0;
      if (reasoningPct > 50) {
        tips.push({
          category: "model_selection",
          severity: "info",
          tip: `${fmtPct(reasoningPct)} of output tokens are reasoning tokens. If you don't need extended thinking for every task, consider disabling it for straightforward requests to reduce output token costs.`,
          estimatedSavings: totalCost * 0.1,
        });
      }

      // Sort tips by severity, then estimated savings
      const severityOrder = { critical: 0, warning: 1, info: 2 };
      tips.sort((a, b) => {
        const sevDiff = severityOrder[a.severity] - severityOrder[b.severity];
        if (sevDiff !== 0) return sevDiff;
        return b.estimatedSavings - a.estimatedSavings;
      });

      const periodLabel =
        params.period === "today"
          ? "Today"
          : params.period === "week"
            ? "Last 7 Days"
            : params.period === "month"
              ? "This Month"
              : "All Time";
      const totalPotentialSavings = tips.reduce((s, t) => s + t.estimatedSavings, 0);

      const lines = [
        header("COST OPTIMIZATION TIPS"),
        `  Period: ${periodLabel}  │  Total Spend: ${fmtCost(totalCost)}`,
        separator(),
        "",
      ];

      if (tips.length === 0) {
        lines.push("  ✅ No optimization issues found! Your usage patterns look efficient.", "");
      } else {
        const severityIcon = { critical: "🔴", warning: "🟡", info: "🔵" };

        for (let i = 0; i < tips.length; i++) {
          const t = tips[i];
          lines.push(
            `  ${severityIcon[t.severity]} [${t.severity.toUpperCase()}] ${t.category}`,
            `     ${t.tip}`,
            `     💰 Estimated savings: ~${fmtCost(t.estimatedSavings)}`,
            ""
          );
        }

        lines.push(
          separator(),
          `  📊 Total Potential Savings: ~${fmtCost(totalPotentialSavings)} (${fmtPct(totalCost > 0 ? (totalPotentialSavings / totalCost) * 100 : 0)} of spend)`,
          ""
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
    }
  );

  // ─── Cleanup Tools ──────────────────────────────────────────

  server.tool(
    "drishti_cleanup_preview",
    "Preview what session data would be deleted for the given filters. " +
      "Shows affected files, directories, database rows, total bytes, and per-project/provider breakdown. " +
      "ALWAYS call this before drishti_cleanup_execute to understand the impact.",
    {
      project: ProjectFilter,
      providers: ProvidersArray,
      since: SinceDate,
      until: UntilDate,
      scope: ScopeEnum,
    },
    async (params) => {
      try {
        const { CleanupService } = await import("@sriinnu/tokmeter-core");
        const opts = buildScanOptions(params);
        const core = await getCore(opts);
        const service = new CleanupService(core);

        const filter = buildCleanupFilter(params);

        const preview = await service.preview(filter);

        if (preview.recordCount === 0) {
          return {
            content: [
              {
                type: "text",
                text: `${header("CLEANUP PREVIEW")}\n\n  No records match the filter. Nothing to clean up.\n`,
              },
            ],
          };
        }

        const lines: string[] = [header("CLEANUP PREVIEW"), ""];

        // Summary
        lines.push(
          `  Records: ${fmtNum(preview.recordCount)}`,
          `  Source Files: ${preview.sourceFileCount}`,
          `  Targets: ${preview.targets.length}`,
          `  Disk Space: ${fmtNum(preview.totalBytes)} bytes`,
          ""
        );

        // By provider
        if (preview.byProvider.length > 0) {
          lines.push("  BY PROVIDER:", separator());
          const rows = preview.byProvider.map((p) => [
            p.provider,
            p.targets.toString(),
            fmtNum(p.bytes),
            p.records.toString(),
          ]);
          lines.push(
            formatTable(["Provider", "Targets", "Bytes", "Records"], rows, [
              false,
              true,
              true,
              true,
            ])
          );
          lines.push("");
        }

        // By project
        if (preview.byProject.length > 0) {
          lines.push("  BY PROJECT:", separator());
          const rows = preview.byProject.map((p) => [
            p.project.slice(0, 30),
            p.records.toString(),
            fmtNum(p.tokens),
            fmtCost(p.cost),
          ]);
          lines.push(
            formatTable(["Project", "Records", "Tokens", "Cost"], rows, [false, true, true, true])
          );
          lines.push("");
        }

        // Partial file warnings
        if (preview.partialFileWarnings.length > 0) {
          lines.push("  ⚠️  PARTIAL FILE WARNINGS:", separator());
          for (const w of preview.partialFileWarnings) {
            const shortFile = w.file
              .split(/[\\/]+/)
              .filter(Boolean)
              .slice(-2)
              .join("/");
            lines.push(
              `  ${shortFile}: ${w.matchedRecords} matched, ${w.otherRecords} other records (${w.otherDateRange}) will ALSO be deleted`
            );
          }
          lines.push("");
        }

        lines.push(
          "  To execute: call drishti_cleanup_execute with the same filters and confirm='DELETE'"
        );

        return { content: [{ type: "text", text: lines.join("\n") + scanFooter() }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `${header("ERROR")}\n\n  ${err instanceof Error ? err.message : String(err)}\n`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "drishti_cleanup_execute",
    "DESTRUCTIVE: Permanently delete session data matching the given filters. " +
      "Creates a backup by default before deleting. " +
      "ALWAYS call drishti_cleanup_preview first. " +
      "Requires confirm='DELETE' as a safety guard.",
    {
      project: ProjectFilter,
      providers: ProvidersArray,
      since: SinceDate,
      until: UntilDate,
      scope: ScopeEnum,
      backup: z
        .boolean()
        .default(true)
        .describe("Create tar.gz backup before deleting (default: true)"),
      confirm: z.string().describe("Must be exactly 'DELETE' to proceed with deletion"),
    },
    async (params) => {
      if (params.confirm !== "DELETE") {
        return {
          content: [
            {
              type: "text",
              text: `${header("SAFETY CHECK")}\n\n  ❌ confirm must be exactly 'DELETE' to proceed.\n  Call drishti_cleanup_preview first to review what will be deleted.\n`,
            },
          ],
          isError: true,
        };
      }

      try {
        const { CleanupService, TokmeterCore: Core } = await import("@sriinnu/tokmeter-core");
        // Fresh core for destructive ops — never use stale cache
        const core = new Core();
        const service = new CleanupService(core);

        const filter = buildCleanupFilter(params);

        const result = await service.execute(filter, { backup: params.backup });

        // Invalidate cached core so next tool call rescans
        _cachedCore = null;

        const lines: string[] = [header("CLEANUP RESULT"), ""];
        lines.push(
          `  ✅ Deleted: ${result.deletedCount} targets`,
          `  💾 Freed: ${fmtNum(result.bytesFreed)} bytes`
        );
        if (result.backupPath) {
          lines.push(`  📦 Backup: ${result.backupPath}`);
        }
        if (result.failedCount > 0) {
          lines.push(`  ❌ Failed: ${result.failedCount}`);
          for (const e of result.errors.slice(0, 5)) {
            lines.push(`     ${e.target}: ${e.error}`);
          }
        }
        lines.push("");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `${header("ERROR")}\n\n  ${err instanceof Error ? err.message : String(err)}\n`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "drishti_backups",
    "List available cleanup backups with metadata (date, size, providers, projects).",
    {},
    async () => {
      const { CleanupService, TokmeterCore: Core } = await import("@sriinnu/tokmeter-core");
      const core = new Core({ skipPricing: true });
      const service = new CleanupService(core);
      const backups = service.listBackups();

      if (backups.length === 0) {
        return {
          content: [{ type: "text", text: `${header("BACKUPS")}\n\n  No backups found.\n` }],
        };
      }

      const lines: string[] = [header("BACKUPS"), ""];
      const rows = backups.map((b) => [
        b.id,
        fmtDate(new Date(b.createdAt).getTime()),
        fmtNum(b.sizeBytes),
        b.providers.join(", "),
      ]);
      lines.push(formatTable(["ID", "Created", "Size", "Providers"], rows));
      lines.push("");

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );

  server.tool(
    "drishti_restore",
    "Restore session data from a cleanup backup. Requires confirm='RESTORE' as a safety guard.",
    {
      backup_id: z.string().describe("Backup ID to restore (from drishti_backups)"),
      confirm: z.string().describe("Must be exactly 'RESTORE' to proceed"),
    },
    async (params) => {
      if (params.confirm !== "RESTORE") {
        return {
          content: [
            {
              type: "text",
              text: `${header("SAFETY CHECK")}\n\n  ❌ confirm must be exactly 'RESTORE' to proceed.\n`,
            },
          ],
          isError: true,
        };
      }

      try {
        const { CleanupService, TokmeterCore: Core } = await import("@sriinnu/tokmeter-core");
        const core = new Core({ skipPricing: true });
        const service = new CleanupService(core);
        const result = service.restore(params.backup_id);

        // Invalidate cached core
        _cachedCore = null;

        const lines: string[] = [header("RESTORE RESULT"), ""];
        if (result.errors.length > 0) {
          lines.push("  ❌ Restore failed:");
          for (const e of result.errors) {
            lines.push(`     ${e.file}: ${e.error}`);
          }
        } else {
          lines.push(`  ✅ Restored ${result.restoredCount} items.`);
        }
        lines.push("");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `${header("ERROR")}\n\n  ${err instanceof Error ? err.message : String(err)}\n`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  return server;
}

// ─────────────────────────────────────────────────────────────
// Entrypoint
// ─────────────────────────────────────────────────────────────

export async function startServer() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
