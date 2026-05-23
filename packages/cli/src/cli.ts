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
    | "install-cron"
    | "uninstall-statusline"
    | "uninstall-mcp"
    | "uninstall-cron"
    | "cron-status"
    | "editors"
    | "digest"
    | "cleanup"
    | "restore"
    | "snapshot"
    | "alias"
    | "config"
    | "kosha-refresh"
    | "kosha-update"
    | "pricing-audit"
    | "routes"
    | "update"
    | "refresh";
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
  install-cron         Install daily kosha-refresh cron (macOS launchd)
  uninstall-statusline Remove statusline hook from all editors
  uninstall-mcp        Remove MCP server from all editors
  uninstall-cron       Remove the daily kosha-refresh cron
  cron-status          Show daily-cron install + last-run state
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
      case "install-cron":
      case "uninstall-statusline":
      case "uninstall-mcp":
      case "uninstall-cron":
      case "cron-status":
      case "editors":
      case "digest":
      case "cleanup":
      case "restore":
      case "snapshot":
      case "kosha-refresh":
      case "kosha-update":
      case "update":
      case "refresh":
      case "pricing-audit":
      case "routes":
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

// ---- pricing-audit ----

/**
 * Export the consumer-side audit of today's pricing resolution.
 *
 * Output shape (JSON only — this command is meant for piping into CI):
 * {
 *   ts: number,
 *   today: { date, totalCost, recordCount, modelCount },
 *   resolved: [{ model, cost, tokens }],
 *   unpriced: [{ model, hits, lastSeenAt }],   // unmet pricing
 *   anomalies: [{ key, field, side, previous, current, deltaPct, ts }],
 *   pricing: { fetchedAt, ageHours },
 * }
 */
async function runPricingAudit(_options: { json: boolean }): Promise<void> {
  const { TokmeterCore } = await import("@sriinnu/tokmeter");
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");

  const core = new TokmeterCore();
  await core.scan();
  const meta = core.getScanMeta();
  // Local-date key (YYYY-MM-DD in user's TZ). Don't use toISOString — it's
  // UTC and silently shifts to yesterday for any positive UTC offset after
  // local midnight, which would make the daily lookup miss today entirely.
  const now = new Date();
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

  // Today's resolved models with cost.
  const todayModels = core.getModelCosts({ today: true }) ?? [];
  const todayDaily = core.getDailyBreakdown({ since: todayKey, until: todayKey })[0] ?? null;
  const resolved = todayModels.map((m) => ({
    model: m.model,
    cost: m.cost,
    tokens: m.totalTokens,
  }));

  // Unpriced — read the wishlist tokmeter just wrote.
  let unpriced: Array<{ id: string; hits: number; lastSeenAt: number }> = [];
  try {
    const wishPath = path.join(os.homedir(), ".tokmeter", "wishlist.json");
    const wish = JSON.parse(fs.readFileSync(wishPath, "utf-8")) as {
      models?: Array<{ id: string; hits: number; lastSeenAt: number }>;
    };
    unpriced = wish.models ?? [];
  } catch {
    /* no wishlist — empty */
  }

  // Anomalies — read kosha's diff log.
  let anomalies: Array<Record<string, unknown>> = [];
  try {
    const anomPath = path.join(os.homedir(), ".kosha", "anomalies.json");
    const a = JSON.parse(fs.readFileSync(anomPath, "utf-8")) as {
      anomalies?: Array<Record<string, unknown>>;
    };
    const cutoff = Date.now() - 24 * 3600 * 1000;
    anomalies = (a.anomalies ?? []).filter(
      (x) => typeof x.ts === "number" && (x.ts as number) >= cutoff
    );
  } catch {
    /* no anomalies file */
  }

  // Pricing freshness — kosha registry mtime.
  let fetchedAt = 0;
  try {
    fetchedAt = fs.statSync(path.join(os.homedir(), ".kosha", "registry.json")).mtimeMs;
  } catch {
    /* missing registry — fetchedAt stays 0 */
  }
  const ageHours = fetchedAt > 0 ? (Date.now() - fetchedAt) / 3_600_000 : null;

  const output = {
    ts: Date.now(),
    today: {
      date: todayKey,
      totalCost: todayDaily?.cost ?? 0,
      recordCount: todayDaily?.records ?? 0,
      modelCount: resolved.length,
    },
    resolved,
    unpriced,
    anomalies,
    pricing: {
      fetchedAt,
      ageHours,
      stale: ageHours !== null && ageHours > 24,
    },
    meta: {
      lastScanAt: meta.lastScanAt,
      todayState: meta.todayState,
      warnings: meta.warnings.length,
    },
  };

  console.log(JSON.stringify(output, null, 2));

  // Exit non-zero when something needs attention — lets CI checks gate on
  // this command without piping into jq.
  if (unpriced.length > 0 || anomalies.length > 0 || output.pricing.stale) {
    process.exit(2);
  }
}

/**
 * `tokmeter routes` — cost surface explorer (MVP per docs/designs/routes.md).
 *
 * Layer 1 only: pure pricing translation. For the scope (today by default,
 * configurable via --project), sums the five token classes once, then asks
 * kosha to project the cost across every available model. Output sorted by
 * projected cost ascending. JSON mode for piping into CI / spreadsheets.
 *
 * Honesty constraints (from the design doc):
 *  - No "Recommended" / "Best value" badges. Sort is honest neutral.
 *  - Models with missing tier pricing get projected at the input rate, the
 *    cell is flagged so the user knows.
 *  - "Actual run" cost uses historical frozen pricing; alternatives use
 *    today's kosha. Both timestamps shown.
 */
async function runRoutes(options: {
  json: boolean;
  project?: string;
}): Promise<void> {
  const { TokmeterCore } = await import("@sriinnu/tokmeter");
  const core = new TokmeterCore();
  await core.scan({ today: true, project: options.project });
  const records = core.getRecords();
  const totals = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
  };
  let actualCost = 0;
  for (const r of records) {
    totals.input += r.inputTokens;
    totals.output += r.outputTokens;
    totals.cacheRead += r.cacheReadTokens;
    totals.cacheWrite += r.cacheWriteTokens;
    totals.reasoning += r.reasoningTokens;
    actualCost += r.cost;
  }
  if (records.length === 0) {
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            scope: { project: options.project, today: true },
            totals,
            actualCost: 0,
            projections: [],
          },
          null,
          2
        )
      );
    } else {
      console.log("No records in scope. Did you mean --project <name>?");
    }
    return;
  }

  // Project against every model in the user's lifetime lineup. The design
  // doc calls for kosha live + non-deprecated chat models — for the MVP we
  // use the same "models the user has actually used" lineup, which has the
  // pragmatic benefit of guaranteed-existing kosha pricing.
  const lifetime = core.getModelCosts();
  const projectionsRaw = await Promise.all(
    lifetime.map(async (m) => ({
      model: m.model,
      provider: m.provider,
      projectedCost: await (
        core as unknown as { pricing: { calculateCost(...args: unknown[]): Promise<number> } }
      ).pricing.calculateCost(
        m.model,
        totals.input,
        totals.output,
        totals.cacheRead,
        totals.cacheWrite,
        totals.reasoning
      ),
    }))
  );
  // Drop $0 projections — these are models with no kosha pricing (synthetic
  // mocks, opaque provider labels like `codex-auto-review`, deprecated entries).
  // Showing them at the top of "cheapest" implies a free alternative when we
  // just don't know the price. Honest to omit rather than misrank.
  const projections = projectionsRaw
    .filter((p) => p.projectedCost > 0.0001)
    .sort((a, b) => a.projectedCost - b.projectedCost);
  const unpriced = projectionsRaw.filter((p) => p.projectedCost <= 0.0001).map((p) => p.model);

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          scope: { project: options.project, today: true },
          totals,
          actualCost,
          projections,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );
    return;
  }

  // Pretty table output.
  console.log("");
  console.log(
    `tokmeter routes — projection for today${options.project ? ` (project: ${options.project})` : ""}`
  );
  console.log("");
  console.log(
    `Tokens: ${totals.input.toLocaleString()} input · ` +
      `${totals.output.toLocaleString()} output · ` +
      `${totals.cacheRead.toLocaleString()} cacheRead · ` +
      `${totals.cacheWrite.toLocaleString()} cacheWrite · ` +
      `${totals.reasoning.toLocaleString()} reasoning`
  );
  console.log(`Actual cost (historical pricing): $${actualCost.toFixed(2)}`);
  console.log("");
  console.log("Projected cost on today's kosha (sorted, cheapest first):");
  console.log("");
  const pad = (s: string, n: number) => s.padEnd(n);
  console.log(
    `  ${pad("MODEL", 38)} ${pad("PROVIDER", 14)} ${pad("PROJECTED", 12)} ${"Δ vs ACTUAL"}`
  );
  console.log(`  ${"─".repeat(38)} ${"─".repeat(14)} ${"─".repeat(12)} ${"─".repeat(11)}`);
  for (const p of projections) {
    const delta = p.projectedCost - actualCost;
    const deltaStr =
      Math.abs(delta) < 0.005
        ? "—"
        : delta < 0
          ? `−$${Math.abs(delta).toFixed(2)}`
          : `+$${delta.toFixed(2)}`;
    console.log(
      `  ${pad(p.model.slice(0, 38), 38)} ${pad(p.provider, 14)} $${pad(p.projectedCost.toFixed(2), 11)} ${deltaStr}`
    );
  }
  console.log("");
  console.log(
    "Note: alternatives use TODAY's kosha pricing; actual uses historical (frozen) pricing."
  );
  console.log(
    "Layer 1 (pure pricing translation) — no cache-economics adjustment for cross-provider differences."
  );
  if (unpriced.length > 0) {
    console.log("");
    console.log(
      `Unpriced models excluded (no kosha price; honest \$? not free): ${unpriced.join(", ")}`
    );
  }
}

// ---- Daemon-read fast path ----

/**
 * HTTP base for the local drishti daemon: DAEMON_HOST:DAEMON_PORT+1
 * (9876 + 1 = 9877). Hardcoded to avoid a build-time subpath dependency on the
 * drishti package internals; the daemon's port is a stable protocol constant.
 */
const DAEMON_HTTP_BASE = "http://127.0.0.1:9877";

async function daemonReady(base: string, timeoutMs: number): Promise<"ready" | "warming" | "down"> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/ready`, { signal: ctrl.signal });
      if (!res.ok) return "down";
      const j = (await res.json()) as { ready?: boolean };
      return j.ready ? "ready" : "warming";
    } finally {
      clearTimeout(t);
    }
  } catch {
    return "down";
  }
}

/**
 * Fast path for `--json` read commands: read the warm singleton daemon over
 * HTTP instead of doing a full-corpus scan. Keeps an external poller (e.g. a
 * status bridge calling `tokmeter stats --json --codex` on a loop) from
 * spawning repeated multi-GB scans — each call becomes a millisecond warm read.
 *
 * Returns false (→ caller falls back to a normal scan) when the daemon is
 * down/warming or the query uses a filter the daemon endpoints don't express
 * (project or date windows). When the daemon is down, we also nudge the
 * singleton up (detached, heap-capped) so the NEXT call is cheap.
 */
async function tryServeFromDaemon(
  command: string,
  args: {
    providers?: ProviderId[];
    project?: string;
    since?: string;
    until?: string;
    today?: boolean;
    week?: boolean;
    month?: boolean;
    year?: number;
  }
): Promise<boolean> {
  const endpoints: Record<string, string> = {
    stats: "/api/stats",
    daily: "/api/daily",
    models: "/api/models",
    projects: "/api/projects",
  };
  const path = endpoints[command];
  if (!path) return false; // overview / unknown shape → scan
  // The daemon read path only expresses a provider filter; anything narrower
  // must scan so results stay exact. `today` is in this list because the
  // daemon endpoints return LIFETIME data — silently returning lifetime
  // when the caller asked for today would be a correctness bug
  // (`tokmeter stats --json --today --codex` getting all-time numbers).
  if (
    args.project ||
    args.since ||
    args.until ||
    args.today ||
    args.week ||
    args.month ||
    args.year
  ) {
    return false;
  }
  // Endpoint capability guard: /api/projects on the daemon ignores the
  // ?providers= filter (it serves the cross-provider per-project breakdown
  // verbatim from the warm core). Letting `projects --json --codex` hit the
  // fast path would silently return all-provider projects — a correctness
  // bug. Force a local scan instead so `--codex` actually narrows. The other
  // three endpoints (stats/daily/models) honor ?providers= correctly.
  if (command === "projects" && args.providers && args.providers.length > 0) {
    return false;
  }

  const base = DAEMON_HTTP_BASE;
  const state = await daemonReady(base, 1500);
  if (state === "down") {
    // Genuinely unreachable — bring the singleton daemon up for next time (it
    // enforces its own PID singleton), then scan this one cold call.
    try {
      const { spawn } = await import("node:child_process");
      const heapMb = process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144";
      spawn(process.execPath, [process.argv[1], "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`.trim(),
        },
      }).unref();
    } catch {}
    return false;
  }
  // Reachable — read it whether "ready" or "warming". A local scan here is
  // exactly the multi-GB balloon we're eliminating, so we MUST NOT fall back to
  // one just because the daemon is mid-refresh. The daemon coalesces refreshes
  // (~0.2s, mtime-pruned) and the data endpoint awaits its own warm core, so a
  // call landing during a refresh just waits briefly.
  //
  // Two-tier timeout (concurrency guard): when the daemon is "ready", data
  // endpoints serve from memory in milliseconds. Anything slower than 15s
  // means a stuck handler — short timeout so 40 concurrent callers can't pile
  // 40 idle sockets each holding the process alive. When "warming", we give a
  // generous 90s for the cold first-warm to finish.

  const qs =
    args.providers && args.providers.length > 0
      ? `?providers=${encodeURIComponent(args.providers.join(","))}`
      : "";
  const timeoutMs = state === "warming" ? 90_000 : 15_000;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}${path}${qs}`, { signal: ctrl.signal });
      if (!res.ok) {
        // Daemon errored (e.g. 500 from a parser bug or a transient warm
        // failure). Surface a one-line hint to stderr so the operator knows
        // why the next call did a local scan, but keep stdout clean for the
        // caller (JSON pipelines must not see this hint mixed in).
        process.stderr.write(
          `tokmeter: daemon returned ${res.status} for ${path}; falling back to local scan.\n`
        );
        return false;
      }
      const body = await res.json();
      console.log(JSON.stringify(body, null, 2));
      return true;
    } finally {
      clearTimeout(t);
    }
  } catch (err) {
    // Differentiate a real abort (timeout) from a transient connection error
    // so the operator can tell "daemon is wedged" from "daemon died mid-read".
    const msg = err instanceof Error ? err.message : String(err);
    const isAbort = err instanceof Error && (err.name === "AbortError" || /aborted/i.test(msg));
    process.stderr.write(
      isAbort
        ? `tokmeter: daemon read timed out after ${timeoutMs}ms (${path}); falling back to local scan.\n`
        : `tokmeter: daemon read failed (${msg}); falling back to local scan.\n`
    );
    return false;
  }
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

  if (
    args.command === "install-cron" ||
    args.command === "uninstall-cron" ||
    args.command === "cron-status"
  ) {
    if (process.platform !== "darwin") {
      console.error("Daily cron is currently macOS-only (uses launchd).");
      process.exit(1);
    }
    const { installDailyCron, uninstallDailyCron, cronStatus } = await import("./cron.js");
    if (args.command === "install-cron") installDailyCron();
    else if (args.command === "uninstall-cron") uninstallDailyCron();
    else cronStatus();
    return;
  }

  if (
    args.command === "update" ||
    args.command === "refresh" ||
    args.command === "kosha-refresh" ||
    args.command === "kosha-update"
  ) {
    // Force a fresh discovery pass against kosha's upstream providers. The
    // next scan will see the bumped kosha mtime via getCachedKoshaMtime()
    // and reset cost=0 on today's records only, so enrichCosts reprices
    // today with new rates. Historical records keep their frozen costs in
    // the scan-cache and are skipped by enrichCosts (cost > 0).
    //
    // DO NOT clear the scan-cache here — wiping cached frozen costs forces
    // the snapshot rebuild path to re-price historical records with current
    // kosha rates, which violates the historical immutability rule.
    try {
      const { refreshKoshaRegistry } = await import("@sriinnu/tokmeter");
      console.log("Refreshing kosha registry...");
      await refreshKoshaRegistry();
      console.log("Kosha registry refreshed. Next scan will reprice today's records.");
    } catch (error) {
      console.error(
        `Failed to refresh kosha: ${error instanceof Error ? error.message : String(error)}`
      );
      process.exit(1);
    }
    return;
  }

  if (args.command === "pricing-audit") {
    // Export the consumer-side audit: which today-models resolved, which
    // didn't, which moved >25%. JSON-only output, pipeable into CI checks
    // / dashboards / Slack alerts. Makes the verification half of the
    // kosha-as-source-of-truth pattern a first-class artifact.
    await runPricingAudit({ json: args.json !== false });
    return;
  }

  if (args.command === "routes") {
    // Cost surface explorer: project today's tokens against every model
    // the user has used. Layer 1 of docs/designs/routes.md — pure pricing
    // translation, no cache-economics adjustment. JSON or pretty table.
    await runRoutes({
      json: args.json === true,
      project: args.project,
    });
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

  // Daemon-read fast path: for `--json` read commands, prefer the warm
  // singleton daemon over a fresh full-corpus scan. This is the fix for
  // external pollers that loop `tokmeter stats/daily --json --codex` — each
  // call becomes a cheap warm read instead of a multi-GB scan. Falls through to
  // a normal scan when the daemon is down/warming or the query is narrower.
  if (args.json) {
    const cmd = args.command || "overview";
    if (await tryServeFromDaemon(cmd, args)) return;
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
