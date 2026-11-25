/**
 * tokmeter CLI argument parser and help text.
 */

import type { ProviderId, ScanOptions } from "@sriinnu/tokmeter";
import { readOwnVersion } from "./cron.js";

export type CliCommand =
  | "models"
  | "daily"
  | "projects"
  | "pricing"
  | "tui"
  | "serve"
  | "stats"
  | "live"
  | "statusline"
  | "slash"
  | "daemon"
  | "install-statusline"
  | "install-mcp"
  | "install-plugin"
  | "uninstall-plugin"
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
  | "refresh"
  | "backfill"
  | "coverage"
  | "quota"
  | "cursor-hook";

export interface CliArgs extends ScanOptions {
  json: boolean;
  light: boolean;
  command?: CliCommand;
  /** For `cursor-hook`: install | uninstall | status, and its own flags. */
  cursorHookSub?: string;
  cursorHookRest?: string[];
  /** For `coverage`: the local day to check (YYYY-MM-DD); default yesterday. */
  date?: string;
  /** For `backfill`: how many recent sealed days to recompute into the relay. */
  backfillDays?: number;
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

export const PROVIDER_FLAG_MAP: Record<string, ProviderId> = {
  "--claude": "claude-code",
  "--opencode": "opencode",
  "--codex": "codex",
  "--gemini": "gemini",
  "--cursor": "cursor",
  "--amp": "amp",
  "--droid": "droid",
  "--openclaw": "openclaw",
  "--pi": "pi",
  "--kimi": "kimi",
  "--qwen": "qwen",
  "--roocode": "roo-code",
  "--kilocode": "kilo",
  "--kilo": "kilo-cli",
  "--mux": "mux",
  "--muse": "muse",
  "--cline": "cline",
  "--augment": "augment",
  "--copilot-cli": "copilot-cli",
  "--deepseek-harness": "deepseek-harness",
  "--ribhu": "ribhu",
  "--chitragupta": "chitragupta",
  "--grok": "grok",
  "--custom": "custom",
  "--synthetic": "synthetic",
  "--antigravity": "antigravity",
  "--zed": "zed",
  "--vscode-copilot": "vscode-copilot",
  "--codex-desktop": "codex-desktop",
};

const SIMPLE_COMMANDS = new Set<CliCommand>([
  "models",
  "daily",
  "projects",
  "stats",
  "tui",
  "serve",
  "pricing",
  "live",
  "statusline",
  "slash",
  "daemon",
  "install-statusline",
  "install-mcp",
  "install-plugin",
  "uninstall-plugin",
  "install-cron",
  "uninstall-statusline",
  "uninstall-mcp",
  "uninstall-cron",
  "cron-status",
  "editors",
  "digest",
  "cleanup",
  "restore",
  "snapshot",
  "kosha-refresh",
  "kosha-update",
  "update",
  "refresh",
  "pricing-audit",
  "routes",
  "coverage",
  "quota",
]);

export const HELP_TEXT = `tokmeter — Token usage tracking for AI coding agents

Usage: tokmeter [command] [options]
       tokmeter --version

Commands:
  projects        Show per-project breakdown (default: overview)
  models          Show per-model breakdown
  daily           Show daily usage over time
  stats           Show overall statistics
  pricing         Show pricing for a model
  update          Refresh the price catalogs now; today reprices on the next scan
  routes          Today's tokens priced on every model you've used, cheapest first
  pricing-audit   JSON: which of today's models resolved a price, and which moved
  digest          Weekly cost digest with trends and tips
                  (aliases: weekly, report)
  backfill        Add a newly supported provider or custom source to
                  sealed history. --days N (default 30). With a provider
                  flag (e.g. --muse), adds only that provider's slice;
                  without one, re-derives every provider (grow-only;
                  --force allows shrinking, back up ~/.cache/tokmeter first)
  coverage        Session files that changed on a day but fed no record:
                  usage the parsers are missing. --date D (default
                  yesterday). The daemon runs it after each day seals.
  cursor sync     Opt-in: download your billed Cursor usage from
                  cursor.com (--since D, --dry-run, --json)
  quota           Plan windows per agent (Codex weekly, Claude Code 5h
                  and 7d, Grok Bot weekly): used %, reset time, and whether the current
                  pace runs out before the reset

Live & Daemon:
  live            Start live TUI dashboard (from tokmeter-mcp)
  statusline      Statusline mode (--ambient, --agent, --watch, --style, --density, --theme, --format)
  slash <cmd>     Render zero-token 66-col /tokmeter card (cockpit|why|quota|live|routes|digest|statusline|doctor)
  daemon start    Start cross-provider aggregation daemon
  daemon stop     Stop the daemon
  daemon status   Check daemon status
  daemon restart  Restart the daemon
  daemon install-agent    Keep it running via launchd (macOS)
  daemon uninstall-agent  Remove the launchd agent

Cleanup:
  cleanup         Delete session data by project/date/provider
  restore         Restore from a cleanup backup
  snapshot        Non-destructive backup (no deletion)
  --dry-run       Preview what would be deleted (no deletion)
  --backup        No-op: cleanup always writes a tar.gz backup first
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
  install-plugin       Install /tokmeter slash command + multi-CLI snippets
  uninstall-plugin     Remove /tokmeter slash command files
  install-cron         Install daily price refresh (macOS launchd)
  uninstall-statusline Remove statusline hook from all editors
  uninstall-mcp        Remove MCP server from all editors
  uninstall-cron       Remove the daily price refresh
  cron-status          Show daily-cron install + last-run state
  editors              List all supported editors
  cursor-hook install  Record Cursor's per-turn token usage via a stop hook
  cursor-hook uninstall  Remove only tokmeter's entry from ~/.cursor/hooks.json
  cursor-hook status   Hook state, journal path, last turn, turns today
                       (--home DIR to use another home, --node PATH, --json)

Date Filters:
  --today         Only today's usage
  --week          Today and previous 6 local calendar days
  --month         Current calendar month
  --year N        Specific year
  --since D       From local date (YYYY-MM-DD; inclusive)
  --until D       Through local date (YYYY-MM-DD; inclusive)
  --older-than N  Completed days before the cutoff date (e.g. 30d, 2w, 1m)

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
  --muse          Only Muse
  --cline         Only Cline
  --augment       Only Augment
  --copilot-cli   Only Copilot CLI
  --deepseek-harness  Only DeepSeek Harness
  --ribhu         Only Ribhu (custom source)
  --chitragupta   Only Chitragupta (custom source)
  --grok          Only Grok (custom source)
  --custom        Only custom sources
  --synthetic     Only Synthetic
  --antigravity   Only Antigravity
  --zed           Only Zed
  --vscode-copilot  Only VS Code Copilot
  --codex-desktop Only Codex Desktop

Output:
  --json          Output as JSON
  --light         Lightweight mode (skip pricing)
`;

/**
 * Parse an --older-than value (e.g. "30d", "2w", "1m") into a cutoff ISO timestamp.
 * Records with timestamp before the cutoff are "older than" the given window.
 * Returns undefined on bad input; caller should error out.
 */
export function olderThanToIsoCutoff(raw: string): string | undefined {
  const m = raw.trim().match(/^(\d+)\s*([dwm])?$/i);
  if (!m) return undefined;
  const n = Number.parseInt(m[1], 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = (m[2] || "d").toLowerCase();
  const days = unit === "w" ? n * 7 : unit === "m" ? n * 30 : n;
  const cutoffMs = Date.now() - days * 86_400_000;
  return new Date(cutoffMs).toISOString();
}

/** Parse CLI `argv` (including node + script prefix) into structured options. */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { json: false, light: false };
  const rest = argv.slice(2);

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const mappedProvider = PROVIDER_FLAG_MAP[arg];
    if (mappedProvider) {
      args.providers = [...(args.providers || []), mappedProvider];
      continue;
    }

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
      case "--date":
        args.date = rest[++i];
        if (!args.date || !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
          console.error("Error: --date requires a day as YYYY-MM-DD");
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
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--backup":
        args.backup = true;
        break;
      case "--force":
        args.force = true;
        break;
      case "--days": {
        const n = Number(rest[++i]);
        if (Number.isFinite(n)) args.backfillDays = Math.round(n);
        break;
      }
      case "--latest":
        args.restoreLatest = true;
        break;
      case "--id":
        args.restoreId = rest[++i];
        break;
      case "--version":
      case "-v":
        console.log(readOwnVersion());
        process.exit(0);
        break;
      case "--help":
      case "-h":
        console.log(HELP_TEXT);
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
      case "backfill":
        args.command = "backfill";
        if (rest[i + 1] && !rest[i + 1].startsWith("-")) {
          const n = Number(rest[++i]);
          if (Number.isFinite(n)) args.backfillDays = Math.round(n);
        }
        break;
      case "alias":
        args.command = "alias";
        args.aliasSub = rest[++i] ?? "list";
        args.aliasRest = rest.slice(i + 1);
        i = rest.length;
        break;
      case "cursor-hook":
        args.command = "cursor-hook";
        args.cursorHookSub = rest[++i] ?? "status";
        args.cursorHookRest = rest.slice(i + 1);
        i = rest.length;
        break;
      case "config":
        args.command = "config";
        args.configSub = rest[++i] ?? "list";
        args.configRest = rest.slice(i + 1);
        i = rest.length;
        break;
      case "weekly":
      case "report":
        args.command = "digest";
        break;
      default:
        if (SIMPLE_COMMANDS.has(arg as CliCommand)) {
          args.command = arg as CliCommand;
          break;
        }
        if (arg.startsWith("-")) {
          console.error(`Error: unknown option ${arg}. Run \`tokmeter --help\` for the list.`);
          process.exit(2);
        }
        if (!args.pricingModel && args.command === "pricing") {
          args.pricingModel = arg;
        }
        if (!arg.startsWith("-") && args.command === "daemon" && !args.daemonCmd) {
          args.daemonCmd = arg;
        }
        break;
    }
  }
  return args;
}
