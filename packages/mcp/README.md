<p align="center"><img src="./logo.svg" width="180" /></p>

<h1 align="center">@sriinnu/drishti</h1>

<p align="center">
  दृष्टि — MCP server + live token observatory for AI coding agents
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sriinnu/drishti"><img src="https://img.shields.io/npm/v/@sriinnu/drishti?style=flat-square&color=6C5CE7&label=npm" alt="npm version" /></a>
  <img src="https://img.shields.io/badge/license-MIT-4834D4?style=flat-square" alt="MIT License" />
  <img src="https://img.shields.io/badge/node-%3E%3D18-0e4429?style=flat-square&logo=node.js" alt="node >= 18" />
</p>

---

**@sriinnu/drishti** (दृष्टि — "vision") is the observation layer for token usage across AI coding agents. It provides an MCP server that exposes token data as tools, a live TUI dashboard, a statusline for editor hooks, and a cross-provider aggregation daemon.

Pairs with [`@sriinnu/tokmeter`](https://www.npmjs.com/package/@sriinnu/tokmeter) for the core parsing engine. Works with Claude Code, Cursor, OpenCode, Codex CLI, Windsurf, Zed, VS Code Copilot, and more.

## Install

```bash
npm install -g @sriinnu/drishti
```

Or run directly:

```bash
npx @sriinnu/drishti
```

## Commands

| Command                           | Description                                 |
| --------------------------------- | ------------------------------------------- |
| `drishti`                         | Start live TUI dashboard (default)          |
| `drishti live`                    | Start live TUI dashboard                    |
| `drishti serve`                   | Start MCP server (stdio transport)          |
| `drishti statusline`              | Statusline mode for editor hooks            |
| `drishti daemon start`            | Start cross-provider aggregation daemon     |
| `drishti daemon stop`             | Stop the daemon                             |
| `drishti daemon status`           | Check daemon status                         |
| `drishti install-statusline`      | Install statusline hook for all editors     |
| `drishti install-mcp`             | Install MCP server for all editors          |
| `drishti install-hooks`           | Install guard hooks (Claude Code)           |
| `drishti install-all`             | Restore everything — statusline + MCP + hooks |
| `drishti editors`                 | List all supported editors                  |

## Usage

### Live Dashboard

```bash
# Launch the real-time TUI observatory
drishti live
```

Interactive terminal dashboard with live-updating token counts, cost breakdowns, and sparkline trends. Refreshes automatically as sessions change.

### MCP Server

```bash
# Start as MCP server (stdio transport for editor integration)
drishti serve
```

#### MCP Configuration

Add to your editor's MCP settings (e.g., `~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "drishti": {
      "command": "npx",
      "args": ["@sriinnu/drishti", "serve"]
    }
  }
}
```

Or with a global install:

```json
{
  "mcpServers": {
    "drishti": {
      "command": "drishti",
      "args": ["serve"]
    }
  }
}
```

Auto-install for all supported editors:

```bash
drishti install-mcp
```

#### MCP Tools

Once connected, drishti exposes these tools to the AI agent:

| Tool               | Description                                    |
| ------------------- | ---------------------------------------------- |
| `token_usage`       | Token usage summary (today / week / month / all-time) |
| `cost_breakdown`    | Cost breakdown by model, provider, or project  |
| `daily_trend`       | Daily usage trend with sparkline               |
| `session_cost`      | Current session cost and burn rate             |
| `budget_check`      | Check remaining budget against a limit         |
| `compare_models`    | Compare cost-efficiency across models          |
| `export_csv`        | Export usage data as CSV                       |

### Statusline

```bash
# Run once for statusline output (designed for editor hooks)
drishti statusline
```

The statusline produces a compact, ANSI-colored summary of your current session's token usage and cost. Designed to be called by editor hooks (Claude Code, OpenCode, etc.) and rendered inline.

Auto-install for all supported editors:

```bash
drishti install-statusline
```

### Daemon

The daemon enables real-time cross-provider aggregation. When running, the statusline shows both your current session totals AND aggregated totals from all open AI coding agents.

```bash
# Start the aggregation daemon
drishti daemon start

# Check status
drishti daemon status

# Stop it
drishti daemon stop
```

### Programmatic API

```typescript
import { startServer } from "@sriinnu/drishti";

// Start MCP server programmatically
await startServer();
```

```typescript
import { startLive } from "@sriinnu/drishti/live.js";

// Launch the live TUI
await startLive();
```

```typescript
import { runStatusline } from "@sriinnu/drishti/statusline.js";

// Run a single statusline tick
await runStatusline();
```

```typescript
import { runDaemonCLI } from "@sriinnu/drishti/daemon/server.js";

// Control the daemon
await runDaemonCLI("start");
await runDaemonCLI("status");
await runDaemonCLI("stop");
```

## Supported Editors

Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, Zed, VS Code Copilot, and more. Run `drishti editors` to see the full list.

## Author

**Srinivas Pendela** — [@sriinnu](https://github.com/sriinnu)

## License

[MIT](https://opensource.org/licenses/MIT)
