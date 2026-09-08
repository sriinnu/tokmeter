# @sriinnu/drishti

MCP server, local daemon, and live usage reporting for AI coding agents.

## Capabilities

### MCP tools

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
Shows project name, session cost, model, token flow (input/output/cache), context window %, burn rate, daily total, per-model breakdown.

### Live TUI
Real-time terminal dashboard with 2-second refresh.

## Usage

```bash
drishti live                # live dashboard
drishti mcp                 # MCP server (stdio)
drishti statusline          # statusline hook
```

## Integration

Use `drishti install-mcp` for the repository's supported editor setup; inspect the generated configuration for your editor. See the [README](README.md) for stdio configuration and APIs.

## License

AGPL-3.0-only; see [licenses and source](../../docs/licensing.md).

## Daemon lifecycle

Use `drishti daemon status` before lifecycle actions. Stop refuses uncertain process identity; do not bypass that refusal by killing a PID read from disk. Startup credentials are published after listener ownership, and concurrent forced rescans share one full refresh. These safeguards do not make process inspection and signalling atomic. See [README](README.md#daemon-ownership-and-refresh).
