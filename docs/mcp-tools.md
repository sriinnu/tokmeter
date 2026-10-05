# MCP tool reference

The `@sriinnu/tokmeter-mcp` server exposes **24 tools**, all prefixed
`tokmeter_`. Start with [`tokmeter_pulse`](#tokmeter_pulse) — it answers most
"what am I spending" questions in one call.

> This page is generated from the tool definitions in
> `packages/mcp/src/server.ts`; the descriptions are the tools' own.

**Install (stdio):**

```json
{ "command": "npx", "args": ["-y", "@sriinnu/tokmeter-mcp", "serve"] }
```

The default command launches a terminal UI, so the MCP entry point is the
`serve` subcommand.

## Tools at a glance

| Group | Tools |
| --- | --- |
| Overview | `tokmeter_pulse`, `tokmeter_digest`, `tokmeter_timeline`, `tokmeter_heatmap`, `tokmeter_streaks` |
| Breakdowns | `tokmeter_models`, `tokmeter_providers`, `tokmeter_projects`, `tokmeter_search` |
| Analysis | `tokmeter_compare`, `tokmeter_forecast`, `tokmeter_efficiency`, `tokmeter_leaderboard`, `tokmeter_anomaly`, `tokmeter_cache_efficiency` |
| Advice | `tokmeter_model_advisor`, `tokmeter_cost_optimization_tips`, `tokmeter_budget`, `tokmeter_budget_alert` |
| Data management | `tokmeter_export`, `tokmeter_backups`, `tokmeter_cleanup_preview`, `tokmeter_cleanup_execute`, `tokmeter_restore` |

## Overview

Start here — one call answers most "what am I spending" questions.

### tokmeter_pulse

Get a quick pulse-check snapshot of token usage — total cost, tokens, active models, projects, and providers. Use this as the default first tool to understand overall AI agent spending. Supports today/week/month/all scopes.

### tokmeter_digest

Generate a concise natural language summary of token usage — like a daily/weekly briefing. Highlights key stats, top spenders, notable trends, and actionable insights in prose form. Use this when the user wants a quick narrative overview rather than tables.

### tokmeter_timeline

Show a day-by-day timeline of token usage with sparkline trends and daily cost/token breakdowns. Use this to see patterns over time — spending spikes, quiet days, and usage trends.

### tokmeter_heatmap

Visualize activity patterns as a heatmap — see which hours of the day and days of the week have the heaviest usage. Shows both cost and token intensity. Use this to understand work patterns and peak usage times.

### tokmeter_streaks

Analyze your AI coding habits — active day streaks, weekend vs weekday usage, session frequency, and consistency metrics. Use this to understand how regularly and intensively you use AI coding agents.

## Breakdowns

Slice usage by the dimension you care about.

### tokmeter_models

Detailed per-model cost and token breakdown with visual bar charts. Shows every model used, its provider, total tokens, cost, and share of total spend. Use this to identify which models are driving cost.

### tokmeter_providers

Compare token usage across providers (Claude Code, Cursor, Codex, Gemini, etc.). Shows cost, tokens, model count, and share for each provider. Use this to understand which AI coding agents are most used and costly.

### tokmeter_projects

Show per-project token usage breakdown — cost, tokens, active days, models used, and date range. Use this to see which projects are consuming the most AI resources.

### tokmeter_search

Flexible search across all token usage records with filtering by model, provider, project, date range, and cost thresholds. Returns individual records sorted by timestamp. Use this to find specific usage events or investigate high-cost records.

## Analysis

Deeper cuts: trends, efficiency, outliers.

### tokmeter_compare

Compare two or more models or providers side-by-side on cost, tokens, efficiency, and usage metrics. Use this when the user wants to know which model or provider is cheaper, more efficient, or more heavily used.

### tokmeter_forecast

Project future AI token costs based on historical burn rates. Calculates daily/weekly/monthly averages and projects costs for the next 7, 30, and 90 days. Also shows trend direction (accelerating, decelerating, or steady). Use this for budgeting.

### tokmeter_efficiency

Analyze cache hit rates, reasoning token ratios, input/output efficiency, and cost-per-token metrics. Shows how efficiently AI agents are using tokens — high cache rates mean less wasted compute. Use this to optimize costs by identifying models or projects with poor cache utilization.

### tokmeter_leaderboard

Rank models and providers by various metrics: total cost, cost-efficiency (cost per 1M tokens), total tokens, cache efficiency, reasoning usage, and output volume. Use this to find the best value models or identify the heaviest hitters.

### tokmeter_anomaly

Detect unusual spending patterns and anomalies in token usage. Identifies days or sessions with cost spikes, sudden model switches, abnormally large requests, and deviation from historical averages. Use this to catch runaway costs or unexpected usage.

### tokmeter_cache_efficiency

Analyze cache hit/miss patterns across sessions. Shows overall cache hit rate, dollar savings from caching, cache write waste, and per-model breakdown. Use this to understand how effectively prompt caching is reducing your costs.

## Advice

Opinionated recommendations derived from your own usage.

### tokmeter_model_advisor

Compare what you actually spent vs what cheaper models would have cost. Shows current spending by model and estimates savings if you downgraded expensive models (e.g., Opus → Sonnet, GPT-5 → GPT-4o). Includes a reference pricing table.

### tokmeter_cost_optimization_tips

Analyze usage patterns and provide actionable cost optimization recommendations. Generates tips based on actual data — cache efficiency, model selection, conversation length, and spending distribution. Each tip includes category, severity, and estimated savings.

### tokmeter_budget

Monitor spending against a budget with visual progress bars and alerts. Set a daily, weekly, or monthly budget and see how close you are to the limit. Shows projected overshoot/undershoot. Use this to stay within spending targets.

### tokmeter_budget_alert

Proactive budget monitoring with configurable daily/weekly/monthly thresholds. Shows current spend, percentage of budget used, projected end-of-period spend, and hours remaining until budget is exceeded. Gives green/yellow/red status indicators.

## Data management

Export, back up, and (carefully) delete raw session data.

### tokmeter_export

Export token usage data as JSON, CSV, or Markdown. Returns the full data payload in the requested format. Use JSON for programmatic consumption, CSV for spreadsheets, Markdown for reports.

### tokmeter_backups

List available cleanup backups with metadata (date, size, providers, projects).

### tokmeter_cleanup_preview

Preview what session data would be deleted for the given filters. Shows affected files, directories, database rows, total bytes, and per-project/provider breakdown. ALWAYS call this before tokmeter_cleanup_execute to understand the impact.

### tokmeter_cleanup_execute

DESTRUCTIVE: Permanently delete session data matching the given filters. Creates a backup by default before deleting. ALWAYS call tokmeter_cleanup_preview first. Requires confirm='DELETE' as a safety guard.

> **Destructive.** Deletes raw session files. Requires `confirm: "DELETE"`
> (enforced inside the server before anything is removed) and writes a
> `.tar.gz` backup first by default. Always call `tokmeter_cleanup_preview`
> first. See [Backup, Snapshot & Restore](backup-restore.md#confirmation-and-backup-where-the-gate-lives).

### tokmeter_restore

Restore session data from a cleanup backup. Requires confirm='RESTORE' as a safety guard.

> Requires `confirm: "RESTORE"` as a safety guard.

## See also

- [Consuming tokmeter](consuming-tokmeter.md) — integration guidance and the daemon HTTP API
- [How the numbers work](how-the-numbers-work.md) — bucket semantics and where estimates enter
- [Backup, Snapshot & Restore](backup-restore.md) — the confirmation/backup model in full
