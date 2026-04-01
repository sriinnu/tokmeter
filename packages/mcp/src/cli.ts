#!/usr/bin/env node
/**
 * @tokmeter/drishti — CLI entry point.
 *
 * Subcommands:
 *   drishti              Start live TUI dashboard (default)
 *   drishti live         Start live TUI dashboard
 *   drishti serve|mcp    Start MCP server (stdio transport)
 *   drishti statusline   Statusline mode (stdin → stdout)
 *   drishti status       Alias for statusline
 *   drishti help         Show usage instructions
 */

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
${t("दृष्टि  @tokmeter/drishti")} ${d("— token observatory for AI coding agents")}

${b("USAGE")}
  ${a("drishti")} ${d("[command]")}

${b("COMMANDS")}
  ${a("live")}          Start the live TUI dashboard ${d("(default)")}
  ${a("serve, mcp")}    Start MCP server via stdio transport
  ${a("statusline")}    Claude Code statusline hook mode
  ${a("status")}        Alias for statusline
  ${a("help")}          Show this help message

${b("MCP INTEGRATION")}
  Add to ${d("~/.claude/settings.json")} to expose token tools inside Claude Code:

  ${d("{")}
    ${d('"mcpServers": {')}
      ${a('"drishti"')}: {
        "command": "npx",
        "args": ["@tokmeter/drishti", "mcp"]
      }
    ${d("}")}
  ${d("}")}

${b("STATUSLINE HOOK")}
  Add to ${d("~/.claude/settings.json")} for a live cost bar in Claude Code:

  ${d("{")}
    ${d('"hooks": {')}
      ${a('"StatusLine"')}: [
        { "command": "npx @tokmeter/drishti statusline" }
      ]
    ${d("}")}
  ${d("}")}

${b("MCP TOOLS")}
  When running as an MCP server, drishti exposes these tools:

  ${a("token_usage")}         Get token usage summary (today / week / month / all-time)
  ${a("cost_breakdown")}      Cost breakdown by model, provider, or project
  ${a("daily_trend")}         Daily usage trend with sparkline
  ${a("session_cost")}        Current session cost and burn rate
  ${a("budget_check")}        Check remaining budget against a limit
  ${a("compare_models")}      Compare cost-efficiency across models
  ${a("export_csv")}          Export usage data as CSV

${d("docs: https://github.com/tokmeter/tokmeter")}
`);
}
