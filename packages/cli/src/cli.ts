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

import { TokmeterCore } from "@sriinnu/tokmeter";
import type { ModelSummary, ProjectSummary, ProviderId, ScanOptions } from "@sriinnu/tokmeter";
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
    | "editors"
    | "digest"
    | "cleanup"
    | "restore"
    | "snapshot"
    | "alias"
    | "config"
    | "kosha-refresh"
    | "kosha-update";
  /** Alias sub-command and its positional arguments. */
  aliasSub?: string;
  aliasRest?: string[];
  /** Config sub-command and its positional arguments. */
  configSub?: string;
  configRest?: string[];
  pricingModel?: string;
  daemonCmd?: string;
  digestPeriod?: "today" | "week" | "month";
  dryRun?: boolean;
  backup?: boolean;
  force?: boolean;
  restoreId?: string;
  restoreLatest?: boolean;
  olderThan?: string;
}

/**
 * Parse an --older-than value (e.g. "30d", "2w", "1m") into a cutoff ISO timestamp.
 * Records with timestamp before the cutoff are "older than" the given window.
 * Returns undefined on bad input; caller should error out.
 */
function olderThanToIsoCutoff(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d+)\s*([dwm])?$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] || "d").toLowerCase();
  const days = unit === "w" ? n * 7 : unit === "m" ? n * 30 : n;
  const cutoffMs = Date.now() - days * 86_400_000;
  return new Date(cutoffMs).toISOString();
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
      case "--older-than": {
        const raw = rest[++i];
        if (!raw) {
          console.error("Error: --older-than requires a value (e.g. 30d, 2w, 1m)");
          process.exit(1);
        }
        args.olderThan = raw;
        break;
      }
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
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--backup":
        args.backup = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--latest":
        args.restoreLatest = true;
        break;
      case "--id":
        args.restoreId = rest[++i];
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
  digest          Weekly cost digest with trends and tips
                  (aliases: weekly, report)

Live & Daemon:
  live            Start live TUI dashboard (from drishti)
  statusline      Statusline mode for Claude Code hooks
  daemon start    Start cross-provider aggregation daemon
  daemon stop     Stop the daemon
  daemon status   Check daemon status

Cleanup:
  cleanup         Delete session data by project/date/provider
  restore         Restore from a cleanup backup
  snapshot        Non-destructive backup (no deletion)
  --dry-run       Preview what would be deleted (no deletion)
  --backup        Create tar.gz backup before deleting
  --force         Skip confirmation prompt
  --id ID         Restore specific backup by ID
  --latest        Restore most recent backup

Aliases (merge variants, tag, hide):
  alias list                      Show current aliases
  alias set     <raw> <display>   Rename one canonical project
  alias merge   <display> <raws>  Merge several canonical projects into one
  alias remove  <raw>             Delete a single alias entry
  alias tag     add|remove|set <display> <tag>...
  alias hide    <display>         Hide project from per-project tables
  alias unhide  <display>
  alias suggest                   Interactive: auto-detect candidates, keep/edit/reject each

Config (knobs in ~/.tokmeter/config.json):
  config list                     Show all knobs with current + default values
  config get    <key>             Read one value
  config set    <key> <value>     Update one value (validated + persisted)
  config reset  [<key>]           Restore defaults (one key or all)
  config path                     Print config file path

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
  --older-than N  Anything older than N (e.g. 30d, 2w, 1m)

Digest Options:
  --period P      Period for digest: today, week (default), month
  --project NAME  Filter digest by project

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
      case "--period": {
        const val = rest[++i];
        if (val !== "today" && val !== "week" && val !== "month") {
          console.error("Error: --period must be today, week, or month");
          process.exit(1);
        }
        args.digestPeriod = val;
        break;
      }
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
      case "digest":
      case "cleanup":
      case "restore":
      case "snapshot":
      case "kosha-refresh":
      case "kosha-update":
        args.command = arg;
        break;
      case "alias":
        args.command = "alias";
        // Consume the remaining tokens as sub-cmd + positional args.
        // Everything left in rest[] (after this index) is alias-specific and
        // should NOT be parsed as top-level flags.
        args.aliasSub = rest[++i] ?? "list";
        args.aliasRest = rest.slice(i + 1);
        i = rest.length; // stop consuming — alias owns the rest
        break;
      case "config":
        args.command = "config";
        args.configSub = rest[++i] ?? "list";
        args.configRest = rest.slice(i + 1);
        i = rest.length; // stop consuming — config owns the rest
        break;
      case "weekly":
      case "report":
        args.command = "digest";
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

  // Translate --older-than Nx into an ISO --until cutoff. "Older than N days"
  // means records with timestamp before (now - N days), i.e. until = that cutoff.
  if (args.olderThan) {
    const cutoff = olderThanToIsoCutoff(args.olderThan);
    if (!cutoff) {
      console.error(
        `Error: invalid --older-than value "${args.olderThan}" (expected e.g. 30d, 2w, 1m)`
      );
      process.exit(1);
    }
    if (args.until) {
      console.error("Error: --older-than and --until are mutually exclusive; pick one.");
      process.exit(1);
    }
    args.until = cutoff;
  }

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

  if (args.command === "kosha-refresh" || args.command === "kosha-update") {
    // Force a fresh discovery pass against kosha's upstream providers, then
    // invalidate tokmeter's scan cache so today's records reprice with the
    // new rates on the next scan. This is the "I just updated my pricing,
    // tell tokmeter" button.
    try {
      const { refreshKoshaRegistry, clearRecordCache } = await import("@sriinnu/tokmeter");
      console.log("Refreshing kosha registry...");
      await refreshKoshaRegistry();
      // Throw away the in-memory + on-disk scan cache so the next scan sees
      // the updated kosha mtime and reprices today's records from scratch.
      // Historical records remain frozen (per project immutability rule) —
      // they get reparsed and repriced but the enrichCosts path skips any
      // entry with cost > 0, so nothing written yesterday changes.
      clearRecordCache();
      console.log("Kosha registry refreshed. Next scan will reprice today's records.");
    } catch (error) {
      console.error(
        `Failed to refresh kosha: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
    return;
  }

  if (args.command === "pricing") {
    const { PricingService } = await import("@sriinnu/tokmeter");
    const pricing = new PricingService();
    await pricing.init();
    const modelId = args.pricingModel;
    if (!modelId) {
      console.log("Usage: tokmeter pricing <model-id>");
      console.log("Example: tokmeter pricing claude-sonnet-4-20250514");
      process.exit(1);
    }
    const p = await pricing.getPricing(modelId);
    if (!p || p.inputPerMillion <= 0 || p.outputPerMillion <= 0) {
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

  // Cleanup command — delegates to separate module
  if (args.command === "cleanup") {
    const { runCleanup } = await import("./cleanup.js");
    await runCleanup({
      project: args.project,
      providers: args.providers,
      since: args.since,
      until: args.until,
      today: args.today,
      week: args.week,
      month: args.month,
      dryRun: args.dryRun,
      backup: args.backup,
      force: args.force,
      json: args.json,
      light: args.light,
      scanOptions: args,
    });
    return;
  }

  // Restore command
  if (args.command === "restore") {
    const { runRestore } = await import("./restore.js");
    await runRestore({
      id: args.restoreId,
      latest: args.restoreLatest,
      json: args.json,
    });
    return;
  }

  // Alias command — manage project display names, tags, and hidden flags.
  if (args.command === "alias") {
    const { runAlias } = await import("./alias.js");
    await runAlias({
      sub: args.aliasSub ?? "list",
      rest: args.aliasRest ?? [],
      json: args.json,
    });
    return;
  }

  // Config command — get/set user config knobs (refresh cadence, CLI defaults).
  if (args.command === "config") {
    const { runConfig } = await import("./config.js");
    await runConfig({
      sub: args.configSub ?? "list",
      rest: args.configRest ?? [],
      json: args.json,
    });
    return;
  }

  // Snapshot command — back up all (or filtered) session data without deleting.
  if (args.command === "snapshot") {
    const { runSnapshot } = await import("./snapshot.js");
    await runSnapshot({
      project: args.project,
      providers: args.providers,
      since: args.since,
      until: args.until,
      today: args.today,
      week: args.week,
      month: args.month,
      json: args.json,
      light: args.light,
    });
    return;
  }

  // Digest command — delegates to separate module
  if (args.command === "digest") {
    const { runDigest } = await import("./digest.js");
    await runDigest({
      period: args.digestPeriod,
      project: args.project,
      json: args.json,
      light: args.light,
      scanOptions: args,
    });
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
