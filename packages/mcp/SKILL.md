# @sriinnu/tokmeter-mcp

MCP server, local daemon, and live usage reporting for AI coding agents.

## Capabilities

### MCP tools

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
| `tokmeter_cleanup_preview`, `tokmeter_cleanup_execute`, `tokmeter_backups`, `tokmeter_restore` | Preview cleanup, delete with confirmation, and restore backups |

### Statusline
Shows project name, session cost, model, token flow (input/output/cache), context window %, burn rate, daily total, per-model breakdown.

### Live TUI
Real-time terminal dashboard with 2-second refresh.

## Usage

```bash
tokmeter-mcp live                # live dashboard
tokmeter-mcp mcp                 # MCP server (stdio)
tokmeter-mcp statusline          # statusline hook
```

## Integration

Use `tokmeter-mcp install-mcp` for the repository's supported editor setup; inspect the generated configuration for your editor. See the [README](README.md) for stdio configuration and APIs.

## License

AGPL-3.0-only; see [licenses and source](../../docs/licensing.md).

## Daemon lifecycle

Use `tokmeter-mcp daemon status` before lifecycle actions. Stop refuses uncertain process identity; do not bypass that refusal by killing a PID read from disk. Startup credentials are published after listener ownership, and concurrent forced rescans share one full refresh. These safeguards do not make process inspection and signalling atomic. See [README](README.md#daemon-ownership-and-refresh).
