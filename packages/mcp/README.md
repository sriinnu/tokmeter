<p align="center">
  <img src="../../logo.svg" alt="tokmeter" width="80" />
</p>

<h1 align="center">@tokmeter/drishti</h1>

<p align="center"><strong>दृष्टि -- MCP server + live token observatory for AI coding agents</strong></p>

---

Drishti (दृष्टि, "vision") is the observability layer for tokmeter. It runs as:

1. **MCP server** -- exposes token usage tools to Claude Code, Codex, Cursor, and any MCP-compatible client
2. **Live TUI** -- real-time terminal dashboard with 2-second polling
3. **Statusline hook** -- compact single-line status for Claude Code's statusline

## Install

```bash
npx @tokmeter/drishti
```

## MCP Server

Add to `~/.claude/.mcp.json`:

```json
{
  "mcpServers": {
    "drishti": {
      "command": "npx",
      "args": ["@tokmeter/drishti", "mcp"]
    }
  }
}
```

### MCP Tools

| Tool | Description |
|------|-------------|
| `token_usage` | Token usage summary (today / week / month / all-time) |
| `cost_breakdown` | Cost breakdown by model, provider, or project |
| `daily_trend` | Daily usage trend with sparkline |
| `session_cost` | Current session cost and burn rate |
| `budget_check` | Check remaining budget against a limit |
| `compare_models` | Compare cost-efficiency across models |
| `export_csv` | Export usage data as CSV |

## Statusline Hook

Add to `~/.claude/settings.json`:

```json
{
  "statusLine": {
    "type": "command",
    "command": "npx @tokmeter/drishti statusline"
  }
}
```

### Statusline Display

```
【♾️】 myproject │ ⚡$5.97 │ sonnet-4-6 │ ↑42.5K ↓18.2K ⟳12.0K │ ███░░░░░░░ 25% │ 🔥$4.55/hr │ today:$37.8
```

Shows: project name, session cost, model, token flow, context %, burn rate, daily total, per-model breakdown.

## Live TUI

```bash
drishti live
```

Real-time dashboard with 2-second refresh. Shows session overview, token breakdown, model costs, and sparklines.

## Commands

| Command | Description |
|---------|-------------|
| `drishti live` | Live TUI dashboard (default) |
| `drishti serve` / `drishti mcp` | Start MCP server (stdio) |
| `drishti statusline` | Statusline hook mode |
| `drishti help` | Show usage |

## License

MIT
