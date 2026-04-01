<p align="center">
  <img src="logo.svg" alt="Tokmeter" width="120" />
</p>

<h1 align="center">tokmeter</h1>

<p align="center"><strong>Token Usage Tracker for AI Coding Agents</strong></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tokmeter/core"><img src="https://img.shields.io/badge/npm-@tokmeter/core-39d353?style=flat-square&logo=npm" alt="npm" /></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-0e4429?style=flat-square&logo=node.js" alt="node" />
  <img src="https://img.shields.io/badge/license-MIT-26a641?style=flat-square" alt="license" />
  <img src="https://img.shields.io/badge/bun-monorepo-39d353?style=flat-square" alt="bun" />
</p>

---

Tokmeter tracks token consumption across **16+ AI coding agents**, breaks it down by **project, model, provider, and day**, and gives you **five surfaces** to explore your data: CLI, TUI, web dashboard, MCP server, and macOS menu bar.

Powered by [`@sriinnu/kosha-discovery`](https://www.npmjs.com/package/@sriinnu/kosha-discovery) for real-time model pricing across 20+ providers.

## Why

AI coding agents burn tokens. Lots of them. Tokmeter answers:

- How much did **this project** cost?
- Which **model** consumed the most tokens?
- What's my **daily spend** trend?
- How do costs break down across **providers**?

No social features. No leaderboard. Just your data, locally.

## Quick Start

```bash
# Run directly
npx @tokmeter/cli

# Or install globally
npm install -g @tokmeter/cli
tokmeter
```

## Packages

| Package | What | Install |
|---------|------|---------|
| [`@tokmeter/core`](packages/core/) | Session parsers, aggregator, pricing, public API | `npm install @tokmeter/core` |
| [`@tokmeter/cli`](packages/cli/) | CLI -- table + JSON output | `npx @tokmeter/cli` |
| [`@tokmeter/tui`](packages/tui/) | Interactive terminal UI with charts | `npx @tokmeter/tui` |
| [`@tokmeter/web`](packages/web/) | React + Plotly web dashboard | See [Web App](#web-app) |
| [`@tokmeter/drishti`](packages/mcp/) | MCP server + live TUI + statusline hook | `npx @tokmeter/drishti` |
| `macos-bar` | Native Swift menu bar app | See [macOS Bar](#macos-menu-bar) |

## CLI Usage

```bash
tokmeter                          # overview (all projects)
tokmeter models                   # per-model cost breakdown
tokmeter daily                    # daily usage over time
tokmeter projects                 # per-project summary
tokmeter stats                    # overall statistics
tokmeter pricing sonnet           # lookup model pricing

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

## Drishti -- MCP Server + Live Observatory

[`@tokmeter/drishti`](packages/mcp/) is the observability layer. It provides:

### MCP Server

Exposes token usage tools to Claude Code, Codex, Cursor, and any MCP client.

```json
// ~/.claude/.mcp.json
{
  "mcpServers": {
    "drishti": {
      "command": "npx",
      "args": ["@tokmeter/drishti", "mcp"]
    }
  }
}
```

**Tools:** `token_usage`, `cost_breakdown`, `daily_trend`, `session_cost`, `budget_check`, `compare_models`, `export_csv`

### Statusline Hook

Live cost bar inside Claude Code:

```json
// ~/.claude/settings.json
{
  "statusLine": {
    "type": "command",
    "command": "npx @tokmeter/drishti statusline"
  }
}
```

```
【♾️】 myproject │ ⚡$5.97 │ sonnet-4-6 │ ↑42.5K ↓18.2K ⟳12.0K │ ███░░░░░░░ 25% │ 🔥$4.55/hr │ today:$37.8
```

### Live TUI

```bash
npx @tokmeter/drishti live
```

Real-time terminal dashboard with 2-second refresh.

## TUI

Interactive terminal UI with bar charts, sparklines, and contribution heatmaps.

```bash
npx @tokmeter/tui
```

| View | Key | Description |
|------|-----|-------------|
| Overview | `1` | Bar charts, sparklines, provider breakdown |
| Models | `2` | Sortable table with inline charts |
| Daily | `3` | Sparkline + heatmap |
| Stats | `4` | Streaks, averages, contribution calendar |

## Web App

React + Plotly dashboard with rich visualizations.

```bash
cd packages/web
bun install
bun run dev
```

Open http://localhost:3000

| Chart | Description |
|-------|-------------|
| Model cost bars | Horizontal bar chart comparing model costs |
| Provider pie | Donut chart of cost split by provider |
| Daily trend | Dual-axis line chart (tokens + cost) |
| Token breakdown | Stacked bars (input/output/cache per model) |
| Contribution heatmap | GitHub-style calendar heatmap |
| 3D surface | Isometric contribution graph |

Export data: `tokmeter --json > packages/web/public/data.json`

## macOS Menu Bar

Native Swift app that lives in your menu bar.

- Today's cost in the menu bar title
- Popup panel with top 3 models bar chart
- 7-day cost sparkline
- Quick stats (projects, active days, streak)

Data bridge: `tokmeter --json > ~/.tokmeter/live.json`

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
| Kilo CLI | `~/.local/share/kilo/kilo.db` |
| Mux | `~/.mux/sessions/` |
| Synthetic | Re-attributed from other sources |

## Pricing

Pricing is resolved via [`@sriinnu/kosha-discovery`](https://github.com/sriinnu/kosha-discovery):

1. **kosha direct** -- authenticated API calls to Anthropic, OpenAI, Google, etc.
2. **Static table** -- 50+ models with accurate direct-API rates
3. **kosha fuzzy** -- 300+ OpenRouter models for the long tail
4. **Reasoning tokens** -- dedicated rates for o1/o3/gemini-thinking/deepseek-r1

Covers: Anthropic, OpenAI, Google, DeepSeek, xAI (Grok), Mistral, Meta (Llama), Moonshot/Kimi, Cohere, Perplexity, Qwen, and more.

## Architecture

```
Session Files (local disk)
    |
@tokmeter/core (parsers -> aggregation -> pricing via @sriinnu/kosha-discovery)
    |
+----------+----------+----------+----------+-----------+
|  CLI     |  TUI     |  Web App | Drishti  | macOS Bar |
| (table)  | (Ink)    | (Plotly) | (MCP)    | (Swift)   |
+----------+----------+----------+----------+-----------+
```

## Development

```bash
git clone https://github.com/sriinnu/tokmeter.git
cd tokmeter
bun install
bun run build

# Dev commands
bun run cli                # CLI
bun run tui                # TUI
bun run dev:web            # Web dashboard
bun run drishti            # Drishti live
bun run drishti:serve      # MCP server
```

## License

MIT &copy; Srinivas Pendela
