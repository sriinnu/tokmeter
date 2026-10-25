# tokmeter-mcp

`@sriinnu/tokmeter-mcp` provides an MCP server for usage queries, a local aggregation daemon, a live terminal UI, and editor statusline hooks.

Pairs with [`@sriinnu/tokmeter`](https://www.npmjs.com/package/@sriinnu/tokmeter) for the core parsing engine. Works with Claude Code, Cursor, OpenCode, Codex CLI, Windsurf, Zed, VS Code Copilot, and more.

## Install

```bash
npm install -g @sriinnu/tokmeter-mcp
```

Or run directly:

```bash
npx @sriinnu/tokmeter-mcp
```

## Commands

| Command                           | Description                                 |
| --------------------------------- | ------------------------------------------- |
| `tokmeter-mcp`                         | Start live TUI dashboard (default)          |
| `tokmeter-mcp live`                    | Start live TUI dashboard                    |
| `tokmeter-mcp serve`                   | Start MCP server (stdio transport)          |
| `tokmeter-mcp statusline`              | Statusline mode for editor hooks            |
| `tokmeter-mcp daemon start`            | Start cross-provider aggregation daemon     |
| `tokmeter-mcp daemon stop`             | Stop the daemon                             |
| `tokmeter-mcp daemon status`           | Check daemon status                         |
| `tokmeter-mcp daemon restart`          | Restart the daemon                          |
| `tokmeter-mcp daemon install-agent`    | Keep it running via a launchd agent (macOS) |
| `tokmeter-mcp daemon uninstall-agent`  | Remove the launchd agent                    |
| `tokmeter-mcp install-statusline`      | Install statusline hook for all editors     |
| `tokmeter-mcp install-mcp`             | Install MCP server for all editors          |
| `tokmeter-mcp install-hooks`           | Install guard hooks (Claude Code)           |
| `tokmeter-mcp install-all`             | Restore everything — statusline + MCP + hooks |
| `tokmeter-mcp uninstall-statusline`, `uninstall-mcp`, `uninstall-hooks` | Remove what the installers added |
| `tokmeter-mcp editors`                 | List all supported editors                  |

## Usage

### Live Dashboard

```bash
# Launch the live terminal UI
tokmeter-mcp live
```

Interactive terminal dashboard with live-updating token counts, cost breakdowns, and sparkline trends. Refreshes automatically as sessions change.

### MCP Server

```bash
# Start as MCP server (stdio transport for editor integration)
tokmeter-mcp serve
```

#### MCP Configuration

For Claude Code, register it with the `claude` CLI:

```bash
claude mcp add tokmeter --scope user -- npx -y @sriinnu/tokmeter-mcp serve
```

For other clients, add this to the client's MCP settings file. The `serve`
argument is required; without it the package starts the terminal dashboard.

```json
{
  "mcpServers": {
    "tokmeter": {
      "command": "npx",
      "args": ["-y", "@sriinnu/tokmeter-mcp", "serve"]
    }
  }
}
```

Or with a global install:

```json
{
  "mcpServers": {
    "tokmeter": {
      "command": "tokmeter-mcp",
      "args": ["serve"]
    }
  }
}
```

Auto-install for all supported editors:

```bash
tokmeter-mcp install-mcp
```

For Claude Code, `install-mcp` (1.15.0 and later) registers it through `claude mcp add --scope user` (or
prints that command when the `claude` CLI isn't on your PATH), and points out
any old, inert entry left in `settings.json`, which you can delete.

For OpenCode, `install-mcp` (1.15.0 and later) writes to `~/.config/opencode/opencode.json` under `mcp`,
in OpenCode's own shape, and removes the old entry:

```json
{
  "mcp": {
    "tokmeter": {
      "type": "local",
      "command": ["npx", "-y", "@sriinnu/tokmeter-mcp", "serve"],
      "enabled": true
    }
  }
}
```

#### MCP Tools

Once connected, the server exposes these tools to the AI agent:

| Tool | Purpose |
| --- | --- |
| `tokmeter_pulse` | Usage snapshot |
| `tokmeter_models`, `tokmeter_providers`, `tokmeter_projects` | Cost and token breakdowns |
| `tokmeter_timeline`, `tokmeter_heatmap` | Usage over time |
| `tokmeter_search`, `tokmeter_compare`, `tokmeter_export` | Search, compare, and export |
| `tokmeter_budget`, `tokmeter_budget_alert`, `tokmeter_forecast` | Budget and forecast estimates |
| `tokmeter_cache_efficiency`, `tokmeter_efficiency`, `tokmeter_anomaly` | Efficiency and anomalies |
| `tokmeter_model_advisor`, `tokmeter_cost_optimization_tips` | Cost suggestions |
| `tokmeter_leaderboard`, `tokmeter_digest`, `tokmeter_streaks` | Reports and usage patterns |
| `tokmeter_cleanup_preview`, `tokmeter_cleanup_execute`, `tokmeter_backups`, `tokmeter_restore` | Preview cleanup; owner-gated delete and restore with mandatory backups |

Since 1.15.0, every tool declares MCP annotations. The 22 reporting
tools are `readOnlyHint: true, openWorldHint: false`. `tokmeter_cleanup_execute`
and `tokmeter_restore` are `destructiveHint: true, idempotentHint: false`.
Both destructive tools are disabled until the machine owner sets
`TOKMETER_ENABLE_DESTRUCTIVE_MCP=1` in the server environment.
`tokmeter_cleanup_execute` also refuses an empty filter and requires the
one-time receipt from a matching preview. It always writes a backup first,
even when passed `backup: false`. `tokmeter_restore` refuses archives with links, special
files or `..` paths, and writes only inside known agent session paths. See
[docs/mcp-tools.md](https://github.com/sriinnu/tokmeter/blob/main/docs/mcp-tools.md) and
[docs/backup-restore.md](https://github.com/sriinnu/tokmeter/blob/main/docs/backup-restore.md).

### Statusline

```bash
# Run once for statusline output (designed for editor hooks)
tokmeter-mcp statusline
```

The statusline produces a compact, ANSI-colored summary of your current session's token usage and cost. Designed to be called by editor hooks (Claude Code, OpenCode, etc.) and rendered inline.

Auto-install for all supported editors:

```bash
tokmeter-mcp install-statusline
```

### Daemon

The daemon enables real-time cross-provider aggregation. When running, the statusline shows both your current session totals AND aggregated totals from all open AI coding agents.

```bash
# Start the aggregation daemon
tokmeter-mcp daemon start

# Check status
tokmeter-mcp daemon status

# Stop it
tokmeter-mcp daemon stop
```

### Programmatic API

```typescript
import { startServer } from "@sriinnu/tokmeter-mcp";

// Start MCP server programmatically
await startServer();
```

```typescript
import { startLive } from "@sriinnu/tokmeter-mcp/live.js";

// Launch the live TUI
await startLive();
```

```typescript
import { runStatusline } from "@sriinnu/tokmeter-mcp/statusline.js";

// Run a single statusline tick
await runStatusline();
```

```typescript
import { runDaemonCLI } from "@sriinnu/tokmeter-mcp/daemon/server.js";

// Control the daemon
await runDaemonCLI("start");
await runDaemonCLI("status");
await runDaemonCLI("stop");
```

## Supported Editors

Claude Code, OpenCode, Codex CLI, Cursor, Windsurf, Zed, VS Code Copilot, and more. Run `tokmeter-mcp editors` to see the full list.

## Author

**Srinivas Pendela** — [@sriinnu](https://github.com/sriinnu)

## License

AGPL-3.0-only. Core source retains MPL-2.0. License texts and the build source snapshot are included in `dist/licenses/`; see [licenses and source](https://github.com/sriinnu/tokmeter/blob/main/docs/licensing.md).

## Daemon ownership and refresh

Status and stop verify the PID against a recorded process start time and command hash. Legacy instances without an identity file must match the installed CLI entrypoint (`@sriinnu/tokmeter-mcp`, or `@sriinnu/drishti` for pre-rename daemons). Uncertain or changed identity is refused; process inspection and signalling are separate OS operations, so this is not an atomic process handle.

Startup publishes credentials and ownership only after acquiring the WebSocket listener. A competing start cannot replace the winner's token. Concurrent full rescans share one active or queued full refresh; incremental refreshes remain serialized. These paths have synthetic identity, refresh-count, and listener-contention tests. Windows process inspection still needs Windows runtime validation.
