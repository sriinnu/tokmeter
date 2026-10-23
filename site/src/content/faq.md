---
title: "FAQ"
source: "https://github.com/sriinnu/tokmeter/wiki/FAQ"
---

**Does any data leave my machine?**
No. Tokmeter reads session files your agents already wrote. No provider API keys, no
telemetry, no account. The CLI's only outbound request is an optional fetch of a public
model-price catalog, which `--light` skips. The macOS app also checks GitHub for
app updates (Sparkle).

**Can another local account read the daemon's usage data?**
Since 1.19.2, private HTTP routes and live WebSocket connections require the
owner's token from `~/.tokmeter/daemon/daemon.token`. `/api/ready` reveals only
health. Upgrade and restart the daemon; an older daemon process keeps its old
behavior until it exits. This is a local access control, not a system sandbox.

**Is the cost a bill?**
It's an estimate. Where a tool reports its own cost, that's used; otherwise cost
is derived from token counts and a public price catalog. Long-context tiers,
negotiated rates, and subscription plans aren't modeled.

**Why doesn't updating prices change yesterday's cost?**
Sealed days are a ledger, frozen at the prices of the day they sealed. Only today
reprices when the catalog updates (since 1.15.0, also when your
`pricing-overrides.json` changes). Lifetime totals mix pricing eras — prefer
`today`/`week`/`month` for a number shown to a human.

**If I delete or archive a thread, do I lose its usage?**
Not since 1.17.1. The day it ran in keeps it: the daemon remembers the last
usage of a session that disappears (including a session deleted inside
OpenCode's, Zed's or Cursor's database) and counts it until the day seals,
even across a restart. Archiving isn't counted twice. Since 1.18.0 a
transcript pruned in place keeps what it lost too (Claude Code, Codex, Kimi,
Copilot CLI, Muse). Sealed days were already safe, since they're stored by
tokmeter, not read from your agents' files.

**Why does the same model show up as `model@provider`?**
OpenCode, Kilo and Kilo CLI route one model through many providers, and the
price differs by route (DeepSeek V4.1 Flash costs about twice as much on
Alibaba as on Ollama Cloud). Since 1.18.0 their models carry the provider that
served them, and a call the tool didn't price is billed at that provider's
rate. Which upstream OpenRouter used isn't on disk, so OpenRouter is priced at
its list rate.

**Which agents are supported?**
20+ formats, including Claude Code, Codex, Gemini CLI, Cursor, OpenCode, Amp,
Muse, Cline, Augment, Copilot CLI, Kimi CLI and Kimi Code, Qwen, Roo, Kilo,
Droid, Zed, and more.
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
