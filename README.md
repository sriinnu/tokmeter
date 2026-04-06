<p align="center">
  <img src="logo.svg" alt="Tokmeter" width="120" />
</p>

<h1 align="center">tokmeter</h1>

<p align="center"><strong>Token Usage Tracker for AI Coding Agents</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@sriinnu/tokmeter-core"><img src="https://img.shields.io/badge/npm-@sriinnu/tokmeter--core-39d353?style=flat-square&logo=npm" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D18-0e4429?style=flat-square&logo=node.js" alt="node" />
  <img src="https://img.shields.io/badge/license-MIT-26a641?style=flat-square" alt="license" />
  <img src="https://img.shields.io/badge/bun-monorepo-39d353?style=flat-square&logo=npm" alt="bun" />
</p>

---

Tokmeter tracks token consumption across **16+ AI coding agents**, breaks it down by **project, model, provider, and day**, and gives you **five surfaces** to explore your data: CLI, TUI, web dashboard, MCP server, and macOS menu bar.

Powered by [`@sriinnu/kosha-discovery`](https://www.npmjs.com/package/@sriinnu/kosha-discovery) for real-time model pricing across 20+ providers including 300+ OpenRouter models.

## Why

AI coding agents burn tokens. Lots of them. Tokmeter answers:

- How much did **this project** cost?
- Which **model** consumed the most tokens?
- What's my **daily spend** trend?
- How do costs break down across **providers**?
- What's my **cache hit rate** and how much is caching saving me?
- Which **cheaper model** could I be using instead?

No social features. No leaderboard. Just your data, locally.

## Quick Start

```bash
# Run directly
npx @sriinnu/tokmeter-cli

# Or install globally
npm install -g @sriinnu/tokmeter-cli
tokmeter
```

## Packages

| Package | What | Install |
|---------|------|---------|
| [`@sriinnu/tokmeter-core`](packages/core/) | Session parsers, aggregator, pricing, public API | `npm install @sriinnu/tokmeter-core` |
| [`@sriinnu/tokmeter-cli`](packages/cli/) | CLI -- table + JSON output + cost digest | `npx @sriinnu/tokmeter-cli` |
| [`@sriinnu/tokmeter-tui`](packages/tui/) | Interactive terminal UI with charts | `npx @sriinnu/tokmeter-tui` |
| [`@sriinnu/tokmeter-web`](packages/web/) | React + Plotly web dashboard with live mode | See [Web App](#web-app) |
| [`@sriinnu/drishti`](packages/mcp/) | MCP server + live TUI + statusline + daemon | `npx @sriinnu/drishti` |

## CLI Usage

```bash
tokmeter                          # overview (all projects)
tokmeter models                   # per-model cost breakdown
tokmeter daily                    # daily usage over time
tokmeter projects                 # per-project summary
tokmeter stats                    # overall statistics
tokmeter pricing sonnet           # lookup model pricing
tokmeter digest                   # weekly cost digest with optimization score
tokmeter digest --period today    # today's digest
tokmeter digest --period month    # monthly digest

# Live & Daemon
tokmeter live                     # TUI dashboard
tokmeter statusline               # Statusline mode
tokmeter daemon start             # Start aggregation daemon
tokmeter daemon stop              # Stop daemon
tokmeter daemon status            # Check daemon status

# Installer (all editors)
tokmeter install-statusline       # Install statusline for ALL editors
tokmeter install-mcp              # Install MCP for ALL editors
tokmeter editors                  # List supported editors

# Filters
tokmeter --project my-app         # specific project
tokmeter --claude --opencode      # specific providers
tokmeter --today                  # today only
tokmeter --week                   # last 7 days
tokmeter --month                  # current month
tokmeter --since 2025-01-01 --until 2025-12-31

# Output
tokmeter --json                   # JSON output (for piping/CI)
tokmeter --light                  # skip pricing (faster)
```

### Cost Digest

The `digest` command gives you a cost report card:

```
+==========================================+
|  Weekly Digest: Mar 30 - Apr 5, 2026     |
+==========================================+

  Total Spend:     $2,847.32
  vs Last Week:    $2,102.55 (+35.4%)
  Daily Average:   $406.76
  Busiest Day:     Thursday ($892.11)

  Cache Efficiency: 98.2% hit rate
  Est. Savings:     $977.52

  Optimization Score: B (85/100)
    Cache:           A (100)
    Model Selection: A (100)
    Discipline:      F (40)

  Tips:
  - You spent $620 on GPT-5.4 today - Sonnet would've cost $124
  - Cache efficiency is solid at 98% - keep sessions active
```

Aliases: `tokmeter weekly`, `tokmeter report`

### Example Output

```
+---------------------------+------------+--------+--------+----------+---------+
| Project                   | Tokens     | Cost   | Models | Providers| Days    |
+---------------------------+------------+--------+--------+----------+---------+
| myapp                     | 2.4M       | $24.20 | 3      | 2        | 14      |
| api-server                | 800.0K     | $8.50  | 2      | 1        | 7       |
| scripts                   | 120.5K     | $1.44  | 1      | 1        | 3       |
+---------------------------+------------+--------+--------+----------+---------+

Total: 3.3M tokens | $34.14 | 24 active days
```

## Drishti -- MCP Server + Live Observatory + Daemon

[`@sriinnu/drishti`](packages/mcp/) is the observability layer. It provides:

### MCP Server

Exposes 20 token usage tools to Claude Code, Codex, Cursor, and any MCP client.

```json
// ~/.claude/settings.json
{
  "mcpServers": {
    "drishti": {
      "command": "npx",
      "args": ["-y", "@sriinnu/drishti", "mcp"]
    }
  }
}
```

**Data Tools:** `token_usage`, `cost_breakdown`, `daily_trend`, `session_cost`, `budget_check`, `compare_models`, `export_csv`

**Cost Intelligence Tools:**
- `cache_efficiency` -- Cache hit rate, dollar savings, per-model breakdown
- `model_advisor` -- What-if analysis (Opus vs Sonnet, GPT-5 vs GPT-4o)
- `budget_alert` -- Proactive budget monitoring with projected spend and alerts
- `cost_optimization_tips` -- Actionable recommendations based on usage patterns

### Statusline Hook

Live animated status bar inside Claude Code with cache hit rate:

```json
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "npx -y @sriinnu/drishti statusline"
  }
}
```

```
【♾️】 ○ ❯ 📂myproject ❯ 🌿main ❯ ⚡$5.97 ❯ sonnet-4 ❯ ↑42.5K ↓18.2K ❯ ⚡98.2% ❯ 🔥$4.55/hr ❯ 📈 today $37.8
```

Features:
- Rainbow animated infinity logo
- Real-time token counts with intensity bars
- Live cost tracking with hourly burn rate
- Cache hit rate indicator (green >80%, yellow 50-80%, red <50%)
- Today's total across all providers
- Cross-provider aggregation when daemon is running
- Bulletproof -- 4 concentric safety layers guarantee output even if dependencies fail

### Cross-Provider Aggregation Daemon

The daemon aggregates token usage across **multiple AI coding assistants running simultaneously**:

```bash
# Start the daemon
tokmeter daemon start

# Check status
tokmeter daemon status

# Stop the daemon
tokmeter daemon stop
```

When multiple Claude Code, Codex, or OpenCode instances are running, the statusline shows **aggregated totals** across all of them in real-time via WebSocket.

### Live TUI

```bash
npx @sriinnu/drishti live
# or
tokmeter live
```

Real-time terminal dashboard with 2-second refresh.

## Universal Installer

Install statusline and MCP across **all supported editors** at once:

```bash
# Install statusline for Claude Code, OpenCode, Codex
tokmeter install-statusline

# Install MCP server for all editors
tokmeter install-mcp

# List supported editors
tokmeter editors
```

Supported editors:
- **Claude Code** -- statusline + MCP
- **OpenCode** -- statusline + MCP
- **Codex** -- statusline + MCP
- **Cursor** -- MCP
- **Windsurf** -- MCP
- **Zed** -- MCP

## TUI

Interactive terminal UI with bar charts, sparklines, and contribution heatmaps.

```bash
npx @sriinnu/tokmeter-tui
```

| View | Key | Description |
|------|-----|-------------|
| Overview | `1` | Bar charts, sparklines, provider breakdown |
| Models | `2` | Sortable table with inline charts |
| Daily | `3` | Sparkline + heatmap |
| Stats | `4` | Streaks, averages, contribution calendar |

## Web App

React + Plotly dashboard with rich visualizations and **live mode**.

```bash
cd packages/web
bun install
bun run dev
```

Open http://localhost:3000

When the daemon is running, the web dashboard connects via WebSocket and shows **live session data** alongside historical charts:
- Green pulsing "Live" indicator when connected
- Real-time cost, token counts, and active sessions
- Per-provider and per-model live breakdowns
- Falls back to static data when daemon is offline

| Chart | Description |
|-------|-------------|
| Model cost bars | Horizontal bar chart comparing model costs |
| Provider pie | Donut chart of cost split by provider |
| Daily trend | Dual-axis line chart (tokens + cost) |
| Token breakdown | Stacked bars (input/output/cache per model) |
| Contribution heatmap | GitHub-style calendar heatmap |

Export data: `tokmeter --json > packages/web/public/data.json`

## Supported Providers

| Provider | Data Location |
|----------|--------------|
| Claude Code | `~/.claude/projects/**/*.jsonl` |
| OpenCode | `~/.local/share/opencode/opencode.db` (SQLite) + legacy JSON |
| Codex CLI | `~/.codex/sessions/*.jsonl` |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.json` |
| Cursor IDE | `~/.config/tokscale/cursor-cache/` (API sync) |
| Amp | `~/.local/share/amp/threads/` |
| Droid | `~/.factory/sessions/` |
| OpenClaw | `~/.openclaw/agents/` + legacy paths |
| Pi | `~/.pi/agent/sessions/` |
| Kimi CLI | `~/.kimi/sessions/` |
| Qwen CLI | `~/.qwen/projects/` |
| Roo Code | VS Code globalStorage |
| Kilo | VS Code globalStorage |
| Kilo CLI | `~/.local/share/kilo/kilo.db` (SQLite) |
| Mux | `~/.mux/sessions/` |
| Synthetic | Re-attributed from other sources |

OpenRouter models (free and paid) are automatically detected via model ID format and priced through kosha-discovery's OpenRouter integration.

## Pricing

Pricing is resolved via [`@sriinnu/kosha-discovery`](https://github.com/sriinnu/kosha-discovery):

1. **Static table** -- 50+ models with accurate direct-api rates
2. **kosha direct** -- authenticated API calls to Anthropic, OpenAI, Google, etc.
3. **kosha fuzzy** -- 300+ OpenRouter models for the long tail
4. **Reasoning tokens** -- dedicated rates for o1/o3/gemini-thinking/deepseek-r1

Covers: Anthropic, OpenAI, Google, DeepSeek, xAI (Grok), Mistral, Meta (Llama), Moonshot/Kimi, Cohere, Perplexity, Qwen, and more.

All formatters are NaN/Infinity-safe -- malformed data never leaks into output.

## Architecture

```
Session Files (local disk)
    |
@sriinnu/tokmeter-core (parsers -> aggregation -> pricing via @sriinnu/kosha-discovery)
    |
+----------+----------+----------+----------+-----------+
|  CLI     |  TUI     |  Web App | Drishti  | Daemon    |
| (table)  | (Ink)    | (Plotly) | (MCP)    | (WebSocket)|
| (digest) |          | (live)   | (20 tools)|           |
+----------+----------+----------+----------+-----------+
```

## Development

```bash
git clone https://github.com/sriinnu/tokmeter.git
cd tokmeter
bun install
bun run build

# Run surfaces
bun run cli                    # CLI overview
bun run cli:models             # Model breakdown
bun run cli:daily              # Daily usage
bun run cli:projects           # Project breakdown
bun run cli:stats              # Statistics
bun run cli:digest             # Cost digest report
bun run cli:pricing            # Model pricing lookup
bun run tui                    # Interactive TUI
bun run dev:web                # Web dashboard (dev server)
bun run drishti:live           # Live TUI dashboard
bun run drishti:serve          # MCP server
bun run drishti:statusline     # Statusline hook

# Daemon
bun run daemon:start           # Start aggregation daemon
bun run daemon:stop            # Stop daemon
bun run daemon:status          # Check daemon status

# Installer
bun run install:statusline     # Install statusline for all editors
bun run install:mcp            # Install MCP for all editors
bun run list:editors           # List supported editors

# Quality
bun run test                   # Run tests (30 tests)
bun run lint                   # Lint
bun run format                 # Format
```

## License

MIT (c) Srinivas Pendela
