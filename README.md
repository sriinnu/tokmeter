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

Tokmeter tracks token consumption across **16+ AI coding agents**, breaks it down by **project, model, provider, and day**, and gives you **four surfaces** to explore your data: CLI, TUI, web dashboard, and macOS menu bar.

Powered by [`@sriinnu/kosha-discovery`](https://www.npmjs.com/package/@sriinnu/kosha-discovery) for real-time model pricing.

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
| `@tokmeter/core` | Session parsers, aggregator, pricing, public API | `npm install @tokmeter/core` |
| `@tokmeter/cli` | CLI — table + JSON output | `npx @tokmeter/cli` |
| `@tokmeter/tui` | Interactive terminal UI with charts | `npx @tokmeter/tui` |
| `@tokmeter/web` | React + Plotly web dashboard | See [Web App](#web-app) |
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
┌──────────────────────────┬────────────┬────────────┬────────┬──────────┬─────────┐
│ Project                  │ Tokens     │ Cost       │ Models │ Providers│ Days    │
├──────────────────────────┼────────────┼────────────┼────────┼──────────┼─────────┤
│ -Users-me-myapp          │ 2.4M       │ $24.20     │ 3      │ 2        │ 14      │
│ -Users-me-api-server     │ 800.0K     │ $8.50      │ 2      │ 1        │ 7       │
│ -Users-me-scripts        │ 120.5K     │ $1.44      │ 1      │ 1        │ 3       │
└──────────────────────────┴────────────┴────────────┴────────┴──────────┴─────────┘

Total: 3.3M tokens | $34.14 | 24 active days
```

## TUI

Interactive terminal UI with bar charts, sparklines, and contribution heatmaps.

```bash
npx @tokmeter/tui
```

| Overview | Models |
|----------|--------|
| Bar charts, sparklines, provider breakdown | Sortable table with inline charts |

| Daily | Stats |
|-------|-------|
| Sparkline + heatmap | Streaks, averages, contribution calendar |

**Key bindings**: `1-4` switch views, `←/→/Tab` navigate, `q` quit

## Web App

React + Plotly dashboard with rich visualizations.

```bash
cd packages/web
bun install
bun run dev
```

Open http://localhost:3000

### Charts

| Chart | Description |
|-------|-------------|
| Model cost bars | Horizontal bar chart comparing model costs |
| Provider pie | Donut chart of cost split by provider |
| Daily trend | Dual-axis line chart (tokens + cost) |
| Token breakdown | Stacked bars (input/output/cache per model) |
| Contribution heatmap | GitHub-style calendar heatmap |
| 3D surface | Isometric contribution graph |

### Data

Export usage data for the web app:

```bash
tokmeter --json > packages/web/public/data.json
```

## macOS Menu Bar

Native Swift app that lives in your menu bar.

**Features:**
- Shows today's cost in the menu bar title
- Popup panel with top 3 models bar chart
- 7-day cost sparkline
- Quick stats (projects, active days, streak)

**Data bridge:**
```bash
tokmeter --json > ~/.tokmeter/live.json
```

The bar app auto-refreshes every 60 seconds.

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

## Public API

Use `@tokmeter/core` as a library in your own projects:

```typescript
import { TokmeterCore } from "@tokmeter/core";

const core = new TokmeterCore();

// Scan all providers
const records = await core.scan();

// Per-project breakdown
const projects = core.getAllProjects();
const myProject = core.getProjectSummary("my-app");

// Per-model costs
const models = core.getModelCosts({ project: "my-app" });

// Daily trend
const daily = core.getDailyBreakdown({ since: "2025-01-01" });

// Overall stats
const stats = core.getStats();
console.log(`$${stats.totalCost.toFixed(2)} across ${stats.projects} projects`);

// Full export
const json = core.toJSON();
```

## Pricing

Pricing is resolved via [`@sriinnu/kosha-discovery`](https://github.com/sriinnu/kosha-discovery), which aggregates:

- **LiteLLM** — community-maintained pricing database
- **OpenRouter** — fallback for newly released models
- **Static overrides** — hardcoded pricing for bleeding-edge models

Includes: input tokens, output tokens, cache read, cache write, and reasoning tokens.

## Architecture

```
Session Files (local disk)
    ↓
@tokmeter/core (parsers → aggregation → pricing via kosha-discovery)
    ↓
┌──────────┬──────────┬──────────────┬──────────┐
│  CLI     │  TUI     │  Web App     │ macOS Bar│
│ (table)  │ (Ink)    │ (Plotly)     │ (Swift)  │
└──────────┴──────────┴──────────────┴──────────┘
```

## Development

```bash
# Clone
git clone https://github.com/sriinnu/tokmeter.git
cd tokmeter

# Install
bun install

# Build
bun run build

# Run CLI in dev mode
bun run cli

# Run TUI in dev mode
bun run tui

# Run web dashboard
bun run dev:web
```

## License

MIT &copy; Srinivas Pendela
