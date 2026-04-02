#!/usr/bin/env node
/**
 * tokmeter — Token usage tracking CLI.
 */

// Process-level error handlers
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
});

import { TokmeterCore } from "@sriinnu/tokmeter-core";
import type { ModelSummary, ProjectSummary, ProviderId, ScanOptions } from "@sriinnu/tokmeter-core";
import Table from "cli-table3";

// ---- Arg parser (lightweight, no deps) ----

interface CliArgs extends ScanOptions {
  json: boolean;
  light: boolean;
  command?:
    | "models"
    | "daily"
    | "projects"
    | "pricing"
    | "tui"
    | "serve"
    | "stats"
    | "live"
    | "statusline"
    | "daemon"
    | "install-statusline"
    | "install-mcp"
    | "uninstall-statusline"
    | "uninstall-mcp"
    | "editors";
  pricingModel?: string;
  daemonCmd?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, light: false };
  const rest = argv.slice(2);

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case "--json":
        args.json = true;
        break;
      case "--light":
        args.light = true;
        break;
      case "--today":
        args.today = true;
        break;
      case "--week":
        args.week = true;
        break;
      case "--month":
        args.month = true;
        break;
      case "--since":
        args.since = rest[++i];
        if (!args.since) {
          console.error("Error: --since requires a date argument");
          process.exit(1);
        }
        break;
      case "--until":
        args.until = rest[++i];
        if (!args.until) {
          console.error("Error: --until requires a date argument");
          process.exit(1);
        }
        break;
      case "--year":
        if (!rest[i + 1] || Number.isNaN(Number(rest[i + 1]))) {
          console.error("Error: --year requires a numeric argument");
          process.exit(1);
        }
        args.year = Number(rest[++i]);
        break;
      case "--project":
        args.project = rest[++i];
        if (!args.project) {
          console.error("Error: --project requires a name argument");
          process.exit(1);
        }
        break;
      case "--claude":
        args.providers = [...(args.providers || []), "claude-code" as ProviderId];
        break;
      case "--opencode":
        args.providers = [...(args.providers || []), "opencode" as ProviderId];
        break;
      case "--codex":
        args.providers = [...(args.providers || []), "codex" as ProviderId];
        break;
      case "--gemini":
        args.providers = [...(args.providers || []), "gemini" as ProviderId];
        break;
      case "--cursor":
        args.providers = [...(args.providers || []), "cursor" as ProviderId];
        break;
      case "--amp":
        args.providers = [...(args.providers || []), "amp" as ProviderId];
        break;
      case "--droid":
        args.providers = [...(args.providers || []), "droid" as ProviderId];
        break;
      case "--openclaw":
        args.providers = [...(args.providers || []), "openclaw" as ProviderId];
        break;
      case "--pi":
        args.providers = [...(args.providers || []), "pi" as ProviderId];
        break;
      case "--kimi":
        args.providers = [...(args.providers || []), "kimi" as ProviderId];
        break;
      case "--qwen":
        args.providers = [...(args.providers || []), "qwen" as ProviderId];
        break;
      case "--roocode":
        args.providers = [...(args.providers || []), "roo-code" as ProviderId];
        break;
      case "--kilocode":
        args.providers = [...(args.providers || []), "kilo" as ProviderId];
        break;
      case "--kilo":
        args.providers = [...(args.providers || []), "kilo-cli" as ProviderId];
        break;
      case "--mux":
        args.providers = [...(args.providers || []), "mux" as ProviderId];
        break;
      case "--synthetic":
        args.providers = [...(args.providers || []), "synthetic" as ProviderId];
        break;
      case "--help":
      case "-h":
        console.log(`tokmeter — Token usage tracking for AI coding agents

Usage: tokmeter [command] [options]

Commands:
  projects        Show per-project breakdown (default: overview)
  models          Show per-model breakdown
  daily           Show daily usage over time
  stats           Show overall statistics
  pricing         Show pricing for a model

Live & Daemon:
  live            Start live TUI dashboard (from drishti)
  statusline      Statusline mode for Claude Code hooks
  daemon start    Start cross-provider aggregation daemon
  daemon stop     Stop the daemon
  daemon status   Check daemon status

Installer:
  install-statusline   Install statusline hook for ALL editors
  install-mcp          Install MCP server for ALL editors
  uninstall-statusline Remove statusline hook from all editors
  uninstall-mcp        Remove MCP server from all editors
  editors              List all supported editors

Date Filters:
  --today         Only today's usage
  --week          Last 7 days
  --month         Current calendar month
  --year N        Specific year
  --since D       From date (YYYY-MM-DD or ISO)
  --until D       To date (inclusive)

Other Filters:
  --project NAME  Filter by project name substring
  --claude        Only Claude Code
  --opencode      Only OpenCode
  --codex         Only Codex CLI
  --gemini        Only Gemini CLI
  --cursor        Only Cursor
  --amp           Only Amp
  --droid         Only Droid
  --openclaw      Only OpenClaw
  --pi            Only Pi
  --kimi          Only Kimi
  --qwen          Only Qwen
  --roocode       Only Roo Code
  --kilocode      Only Kilo Code
  --kilo          Only Kilo CLI
  --mux           Only Mux
  --synthetic     Only Synthetic

Output:
  --json          Output as JSON
  --light         Lightweight mode (skip pricing)
`);
        process.exit(0);
        break;
      case "models":
      case "daily":
      case "projects":
      case "stats":
      case "tui":
      case "serve":
      case "pricing":
      case "live":
      case "statusline":
      case "daemon":
      case "install-statusline":
      case "install-mcp":
      case "uninstall-statusline":
      case "uninstall-mcp":
      case "editors":
        args.command = arg;
        break;
      default:
        if (!arg.startsWith("-") && !args.pricingModel && args.command === "pricing") {
          args.pricingModel = arg;
        }
        // Daemon subcommand
        if (!arg.startsWith("-") && args.command === "daemon" && !args.daemonCmd) {
          args.daemonCmd = arg;
        }
        break;
    }
  }
  return args;
}

// ---- Formatters ----

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function formatCost(n: number): string {
  return `$${n.toFixed(2)}`;
}

// ---- Table renderers ----

function renderProjectsTable(projects: ProjectSummary[]) {
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

function renderModelsTable(models: ModelSummary[]) {
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

function renderDailyTable(daily: ReturnType<TokmeterCore["getDailyBreakdown"]>) {
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

function renderStats(stats: ReturnType<TokmeterCore["getStats"]>) {
  const table = new Table({
    head: ["Metric", "Value"],
    colWidths: [20, 30],
  });

  table.push(
    ["Total Tokens", formatNumber(stats.totalTokens)],
    ["Total Cost", formatCost(stats.totalCost)],
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

// ---- Main ----

async function main() {
  const args = parseArgs(process.argv);
  const core = new TokmeterCore({ skipPricing: args.light });

  // Handle special commands first
  if (args.command === "tui") {
    console.log("TUI mode — run `tokmeter-tui` or use packages/tui");
    process.exit(0);
  }

  if (args.command === "serve") {
    console.log("Web server — run `tokmeter-serve` or use packages/web");
    process.exit(0);
  }

  // Delegate to drishti for live/statusline/daemon commands
  if (args.command === "live") {
    const { startLive } = await import("@sriinnu/drishti/live.js");
    await startLive();
    return;
  }

  if (args.command === "statusline") {
    const { runStatusline } = await import("@sriinnu/drishti/statusline.js");
    await runStatusline();
    return;
  }

  if (args.command === "daemon") {
    const { runDaemonCLI } = await import("@sriinnu/drishti/daemon/server.js");
    runDaemonCLI(args.daemonCmd ?? "status");
    return;
  }

  // Installer commands
  if (args.command === "install-statusline") {
    const { installStatusline } = await import("@sriinnu/drishti/installer.js");
    installStatusline();
    return;
  }

  if (args.command === "install-mcp") {
    const { installMCP } = await import("@sriinnu/drishti/installer.js");
    installMCP();
    return;
  }

  if (args.command === "uninstall-statusline") {
    const { uninstallStatusline } = await import("@sriinnu/drishti/installer.js");
    uninstallStatusline();
    return;
  }

  if (args.command === "uninstall-mcp") {
    const { uninstallMCP } = await import("@sriinnu/drishti/installer.js");
    uninstallMCP();
    return;
  }

  if (args.command === "editors") {
    const { listEditors } = await import("@sriinnu/drishti/installer.js");
    listEditors();
    return;
  }

  if (args.command === "pricing") {
    const { PricingService } = await import("@sriinnu/tokmeter-core");
    const pricing = new PricingService();
    await pricing.init();
    const modelId = args.pricingModel;
    if (!modelId) {
      console.log("Usage: tokmeter pricing <model-id>");
      console.log("Example: tokmeter pricing claude-sonnet-4-20250514");
      process.exit(1);
    }
    const p = await pricing.getPricing(modelId);
    if (!p) {
      console.log(`No pricing found for model: ${modelId}`);
      process.exit(1);
    }
    if (args.json) {
      console.log(JSON.stringify({ model: modelId, pricing: p }, null, 2));
    } else {
      const table = new Table({ head: ["Metric", "Per Million Tokens"], colWidths: [25, 20] });
      table.push(
        ["Input", `$${(p.inputPerMillion ?? 0).toFixed(2)}`],
        ["Output", `$${(p.outputPerMillion ?? 0).toFixed(2)}`],
        [
          "Cache Read",
          p.cacheReadPerMillion != null ? `$${p.cacheReadPerMillion.toFixed(2)}` : "N/A",
        ],
        [
          "Cache Write",
          p.cacheWritePerMillion != null ? `$${p.cacheWritePerMillion.toFixed(2)}` : "N/A",
        ]
      );
      console.log(`Pricing for: ${modelId}`);
      console.log(table.toString());
    }
    return;
  }

  // Scan session files
  const records = await core.scan(args);

  if (records.length === 0) {
    console.log("No token usage data found.");
    console.log("\nMake sure you have session files from supported AI coding agents:");
    console.log("  Claude Code: ~/.claude/projects/");
    console.log("  OpenCode: ~/.local/share/opencode/");
    console.log("  Codex CLI: ~/.codex/sessions/");
    console.log("  Gemini CLI: ~/.gemini/tmp/");
    console.log("  and more... Run `tokmeter --help` for all supported platforms.");
    process.exit(0);
  }

  // JSON output
  if (args.json) {
    const command = args.command || "overview";
    switch (command) {
      case "models":
        console.log(JSON.stringify(core.getModelCosts({ project: args.project }), null, 2));
        break;
      case "daily":
        console.log(JSON.stringify(core.getDailyBreakdown({ project: args.project }), null, 2));
        break;
      case "projects":
        console.log(JSON.stringify(core.getAllProjects(), null, 2));
        break;
      case "stats":
        console.log(JSON.stringify(core.getStats(), null, 2));
        break;
      default:
        console.log(JSON.stringify(core.toJSON(), null, 2));
    }
    return;
  }

  // Table output
  const command = args.command || "overview";
  switch (command) {
    case "models":
      renderModelsTable(core.getModelCosts({ project: args.project }));
      break;
    case "daily":
      renderDailyTable(core.getDailyBreakdown({ project: args.project }));
      break;
    case "projects":
      renderProjectsTable(core.getAllProjects());
      break;
    case "stats":
      renderStats(core.getStats());
      break;
    default: {
      // Overview: projects + totals
      const stats = core.getStats();
      renderProjectsTable(core.getAllProjects());
      console.log(
        `\nTotal: ${formatNumber(stats.totalTokens)} tokens | ${formatCost(stats.totalCost)} | ${stats.activeDays} active days`
      );
    }
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
