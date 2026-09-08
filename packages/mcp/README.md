# Drishti

`@sriinnu/drishti` provides an MCP server for usage queries, a local aggregation daemon, a live terminal UI, and editor statusline hooks.

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
# Launch the live terminal UI
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

| Tool | Purpose |
| --- | --- |
| `drishti_pulse` | Usage snapshot |
| `drishti_models`, `drishti_providers`, `drishti_projects` | Cost and token breakdowns |
| `drishti_timeline`, `drishti_heatmap` | Usage over time |
| `drishti_search`, `drishti_compare`, `drishti_export` | Search, compare, and export |
| `drishti_budget`, `drishti_budget_alert`, `drishti_forecast` | Budget and forecast estimates |
| `drishti_cache_efficiency`, `drishti_efficiency`, `drishti_anomaly` | Efficiency and anomalies |
| `drishti_model_advisor`, `drishti_cost_optimization_tips` | Cost suggestions |
| `drishti_leaderboard`, `drishti_digest`, `drishti_streaks` | Reports and usage patterns |
| `drishti_cleanup_preview`, `drishti_cleanup_execute`, `drishti_backups`, `drishti_restore` | Preview cleanup, delete with confirmation, and restore backups |

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

AGPL-3.0-only. Core source retains MPL-2.0. License texts and the build source snapshot are included in `dist/licenses/`; see [licenses and source](https://github.com/sriinnu/tokmeter/blob/main/docs/licensing.md).

## Daemon ownership and refresh

Status and stop verify the PID against a recorded process start time and command hash. Legacy instances without an identity file must match the installed Drishti CLI entrypoint. Uncertain or changed identity is refused; process inspection and signalling are separate OS operations, so this is not an atomic process handle.

Startup publishes credentials and ownership only after acquiring the WebSocket listener. A competing start cannot replace the winner's token. Concurrent full rescans share one active or queued full refresh; incremental refreshes remain serialized. These paths have synthetic identity, refresh-count, and listener-contention tests. Windows process inspection still needs Windows runtime validation.
