# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-04-01

### Added
- **@tokmeter/core** — Token tracking engine with 16 provider parsers (Claude Code, Codex, Cursor, OpenCode, Gemini, Amp, Droid, Kilo, Kilo CLI, Kimi, Mux, OpenClaw, Pi, Qwen, Roo Code, Synthetic)
- **@tokmeter/core** — 4-tier pricing via @sriinnu/kosha-discovery (20+ providers with static, kosha direct, kosha fuzzy tiers)
- **@tokmeter/core** — Aggregation utilities for model costs, daily breakdown, and statistics
- **@tokmeter/cli** — CLI with table, JSON, and pricing lookup modes
- **@tokmeter/tui** — Interactive TUI with bar charts, sparklines, and heatmaps
- **@tokmeter/web** — React + Plotly web dashboard with multiple views (Dashboard, Models, Projects, Timeline, 3D)
- **@tokmeter/drishti** — MCP server exposing 16 tools for token usage analysis
- **@tokmeter/drishti** — Statusline hook for Claude Code with TrueColor support, project/branch display, and per-model breakdown
- **@tokmeter/drishti** — Live TUI dashboard for real-time token monitoring
- README.md and SKILL.md documentation for all packages
- MIT license
- TypeScript strict mode with declaration files (.d.ts)
- ESM with proper exports map
- Monorepo workspace setup with Bun
