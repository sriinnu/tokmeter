#!/usr/bin/env node
/**
 * @tokmeter/drishti — CLI entry point.
 *
 * Subcommands:
 *   drishti                        Start live TUI dashboard (default)
 *   drishti live                   Start live TUI dashboard
 *   drishti serve|mcp              Start MCP server (stdio transport)
 *   drishti statusline|status      Statusline mode (stdin → stdout)
 *   drishti daemon start           Start cross-provider aggregation daemon
 *   drishti daemon stop            Stop the daemon
 *   drishti daemon status          Check daemon status
 *   drishti install-statusline     Install statusline hook for ALL editors
 *   drishti install-mcp            Install MCP server for ALL editors
 *   drishti uninstall-statusline   Remove statusline hook from all editors
 *   drishti uninstall-mcp          Remove MCP server from all editors
 *   drishti editors                List all supported editors
 *   drishti help                   Show usage instructions
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

// Force chalk to output ANSI colors even when stdout is not a TTY.
// The statusline runs as a subprocess hook (stdout → Claude Code, not a terminal),
// so chalk's auto-detection strips colors. FORCE_COLOR makes them always emit.
process.env.FORCE_COLOR = "3";

import { C } from "./formatter.js";

const command = process.argv[2] ?? "live";

switch (command) {
  case "live": {
    const { startLive } = await import("./live.js");
    await startLive();
    break;
  }

  case "serve":
  case "mcp": {
    const { startServer } = await import("./server.js");
    await startServer();
    break;
  }

  case "statusline":
  case "status": {
    const { runStatusline } = await import("./statusline.js");
    await runStatusline();
    break;
  }

  case "install-statusline":
  case "statusline-install": {
    const { installStatusline } = await import("./installer.js");
    const targetEditors = process.argv.slice(3);
    installStatusline(targetEditors.length > 0 ? targetEditors : undefined);
    break;
  }

  case "install-mcp":
  case "mcp-install": {
    const { installMCP } = await import("./installer.js");
    const targetEditors = process.argv.slice(3);
    installMCP(targetEditors.length > 0 ? targetEditors : undefined);
    break;
  }

  case "uninstall-statusline":
  case "statusline-uninstall": {
    const { uninstallStatusline } = await import("./installer.js");
    const targetEditors = process.argv.slice(3);
    uninstallStatusline(targetEditors.length > 0 ? targetEditors : undefined);
    break;
  }

  case "uninstall-mcp":
  case "mcp-uninstall": {
    const { uninstallMCP } = await import("./installer.js");
    const targetEditors = process.argv.slice(3);
    uninstallMCP(targetEditors.length > 0 ? targetEditors : undefined);
    break;
  }

  case "editors": {
    const { listEditors } = await import("./installer.js");
    listEditors();
    break;
  }

  case "daemon": {
    const { runDaemonCLI } = await import("./daemon/server.js");
    const daemonCmd = process.argv[3] ?? "status";
    runDaemonCLI(daemonCmd);
    break;
  }

  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;

  default:
    console.error(C.danger(`Unknown command: ${command}\n`));
    printHelp();
    process.exit(1);
}

// ─── Help ───────────────────────────────────────────────────────────

function printHelp(): void {
  const b = C.bold;
  const d = C.dim;
  const t = C.title;
  const a = C.accent;

  console.log(`
${t("【♾️】 दृष्टि  @tokmeter/drishti")} ${d("— token observatory for AI coding agents")}

${b("USAGE")}
  ${a("drishti")} ${d("[command]")}

${b("COMMANDS")}
  ${a("live")}              Start the live TUI dashboard ${d("(default)")}
  ${a("serve, mcp")}        Start MCP server via stdio transport
  ${a("statusline")}        Claude Code statusline hook mode
  ${a("status")}            Alias for statusline
  ${a("daemon start")}      Start cross-provider aggregation daemon
  ${a("daemon stop")}       Stop the daemon
  ${a("daemon status")}     Check daemon status
  ${a("install-statusline")} Install statusline hook for ALL editors
  ${a("install-mcp")}       Install MCP server for ALL editors
  ${a("uninstall-statusline")} Remove statusline hook from all editors
  ${a("uninstall-mcp")}     Remove MCP server from all editors
  ${a("editors")}           List all supported editors
  ${a("help")}              Show this help message

${b("DAEMON — Cross-Provider Aggregation")}
  The daemon enables real-time aggregation across multiple AI coding assistants.
  When running, the statusline shows both your session AND totals from all
  open windows (Claude Code, Cursor, Codex, etc.)

  ${d("# Start the daemon")}
  ${a("drishti daemon start")}

  ${d("# Check if running")}
  ${a("drishti daemon status")}

  ${d("# Stop the daemon")}
  ${a("drishti daemon stop")}

${b("SUPPORTED EDITORS")}
  Claude Code, OpenCode, Codex, Cursor, Windsurf, Zed, VS Code Copilot

${b("INSTALL EXAMPLES")}
  ${d("# Install statusline for ALL editors")}
  ${a("drishti install-statusline")}

  ${d("# Install MCP for ALL editors")}
  ${a("drishti install-mcp")}

  ${d("# Install for specific editor(s)")}
  ${a("drishti install-statusline claude opencode")}

${b("MCP TOOLS")}
  When running as an MCP server, drishti exposes these tools:

  ${a("token_usage")}         Get token usage summary (today / week / month / all-time)
  ${a("cost_breakdown")}      Cost breakdown by model, provider, or project
  ${a("daily_trend")}         Daily usage trend with sparkline
  ${a("session_cost")}        Current session cost and burn rate
  ${a("budget_check")}        Check remaining budget against a limit
  ${a("compare_models")}      Compare cost-efficiency across models
  ${a("export_csv")}          Export usage data as CSV

${d("docs: https://github.com/sriinnu/tokmeter")}
`);
}
