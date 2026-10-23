---
title: "Installation"
source: "https://github.com/sriinnu/tokmeter/wiki/Installation"
---

Requires Node.js 18+. Tools that keep their history in SQLite — OpenCode, Kilo
CLI, Cursor, Zed, Codex Desktop, Antigravity — need **Node 22.13+** (or 23.4+)
for its built-in `node:sqlite`; on older Node those sources stay empty. Reading
session files needs no provider credentials; pricing lookups fetch a public
catalog, and `--light` skips them.

## Try it without installing

```sh
npx -y @sriinnu/tokmeter --today
```

## CLI + TUI

```sh
npm install -g @sriinnu/tokmeter
tokmeter --today
tokmeter-tui
```

## Daemon, MCP server, statusline

These live in `@sriinnu/tokmeter-mcp`:

```sh
npm install -g @sriinnu/tokmeter-mcp
tokmeter-mcp daemon start      # warm aggregation daemon (HTTP 9877, WS 9876)
tokmeter-mcp serve             # MCP server over stdio
tokmeter-mcp statusline        # one statusline tick
```

MCP client config (stdio):

```json
{ "command": "npx", "args": ["-y", "@sriinnu/tokmeter-mcp", "serve"] }
```

For Claude Code, register it with its CLI instead of editing a file:

```bash
claude mcp add tokmeter --scope user -- npx -y @sriinnu/tokmeter-mcp serve
```

Since 1.15.0, `tokmeter-mcp install-mcp` runs `claude mcp add` for you. Older
versions wrote the entry to `~/.claude/settings.json`, which Claude Code doesn't
load MCP servers from; if you set it up that way, delete that entry.

The default command launches a terminal UI, so the MCP entry point is the
`serve` subcommand. On macOS, `tokmeter-mcp daemon install-agent` installs a
launchd LaunchAgent so the daemon auto-starts at login and respawns on crash.

After upgrading to 1.19.2, restart the daemon so its protected HTTP and
WebSocket listeners replace the older process:

```sh
tokmeter-mcp daemon restart
tokmeter-mcp daemon status
```

The token is created under `~/.tokmeter/daemon/`; keep that directory private.
Existing Tokmeter settings and caches are tightened to owner-only permissions
as the new version uses them. No provider credentials are needed.

## macOS menubar app

Apple silicon, macOS 14+.

```sh
brew install --cask sriinnu/homebrew-tap/tokmeterbar
```

Or download `TokmeterBar-<version>.zip` from
[GitHub Releases](https://github.com/sriinnu/tokmeter/releases) and move it to
`/Applications`. The app auto-updates via Sparkle from a signed appcast.
