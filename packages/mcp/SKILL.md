# @tokmeter/drishti

MCP server + live token observatory for AI coding agents.

## Capabilities

### MCP Tools
- `token_usage` -- usage summary (today/week/month/all-time)
- `cost_breakdown` -- cost by model, provider, or project
- `daily_trend` -- daily usage with sparkline
- `session_cost` -- current session cost and burn rate
- `budget_check` -- check against a spending limit
- `compare_models` -- compare cost-efficiency across models
- `export_csv` -- export as CSV

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

Claude Code: `~/.claude/.mcp.json` and `~/.claude/settings.json` statusLine
Codex: `~/.codex/config.toml` [mcp_servers.drishti]
