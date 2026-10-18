---
title: "FAQ"
source: "https://github.com/sriinnu/tokmeter/wiki/FAQ"
---

**Does any data leave my machine?**
No. Tokmeter reads session files your agents already wrote. No API keys, no
telemetry, no account. The CLI's only outbound request is an optional fetch of a public
model-price catalog, which `--light` skips. The macOS app also checks GitHub for
app updates (Sparkle).

**Is the cost a bill?**
It's an estimate. Where a tool reports its own cost, that's used; otherwise cost
is derived from token counts and a public price catalog. Long-context tiers,
negotiated rates, and subscription plans aren't modeled.

**Why doesn't updating prices change yesterday's cost?**
Sealed days are a ledger, frozen at the prices of the day they sealed. Only today
reprices when the catalog updates (since 1.15.0, also when your
`pricing-overrides.json` changes). Lifetime totals mix pricing eras — prefer
`today`/`week`/`month` for a number shown to a human.

**Which agents are supported?**
20+ formats, including Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Amp,
Muse, Cline, Augment, Copilot CLI, Kimi, Qwen, Roo, Kilo, Droid, Zed, and more.
An agent with no built-in parser can register a path and emit a usage line via
`customSources`; Ribhu and Chitragupta are tracked this way.

**Can I delete old session data safely?**
Yes — `tokmeter cleanup` always backs up first, and since 1.15.0 so does
`tokmeter_cleanup_execute`: it ignores `backup: false` and says so. An empty
filter, which would match everything, is refused.
Scope it to `--until` yesterday or older: sealed days survive in the relay ledger,
but today isn't sealed until midnight rollover. See
[CLI reference](/cli/) and
[Backup & restore](https://github.com/sriinnu/tokmeter/blob/main/docs/backup-restore.md).

**What's the difference between the two npm packages?**
`@sriinnu/tokmeter` is the core API + CLI + TUI. `@sriinnu/tokmeter-mcp` is the
MCP server, daemon, and statusline (it was `@sriinnu/drishti` through 1.12.0).

**Is it free / open source?**
Applications are AGPL-3.0-only; core source is MPL-2.0.
