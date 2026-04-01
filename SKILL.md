# tokmeter

Token usage tracker for AI coding agents. Tracks consumption across 16+ providers, breaks it down by project, model, provider, and day.

## Capabilities

- Scan and parse token usage from Claude Code, Codex, Cursor, Gemini, OpenCode, Amp, Droid, Pi, Kimi, Qwen, Roo Code, Kilo, Mux, OpenClaw
- Calculate costs using @sriinnu/kosha-discovery (20+ provider pricing)
- Display usage in CLI tables, interactive TUI, web dashboard, or macOS menu bar
- Export as JSON or CSV for CI/automation
- Real-time monitoring via MCP server (drishti) or statusline hook

## Packages

| Package | Purpose |
|---------|---------|
| `@tokmeter/core` | Session parsers, aggregation, pricing engine |
| `@tokmeter/cli` | CLI with table/JSON output |
| `@tokmeter/tui` | Interactive terminal dashboard (Ink) |
| `@tokmeter/web` | React + Plotly web dashboard |
| `@tokmeter/drishti` | MCP server + live TUI + statusline hook |

## Quick Start

```bash
npx @tokmeter/cli              # CLI overview
npx @tokmeter/tui              # TUI dashboard
npx @tokmeter/drishti live     # Live monitoring
```
