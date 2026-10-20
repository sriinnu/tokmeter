---
title: "MCP & daemon"
source: "https://github.com/sriinnu/tokmeter/wiki/MCP-and-Daemon"
---

## MCP server (for agents)

Published as `io.github.sriinnu/tokmeter` in the MCP registry, shipped in
`@sriinnu/tokmeter-mcp`. The entry point is the `serve` subcommand:

```json
{ "command": "npx", "args": ["-y", "@sriinnu/tokmeter-mcp", "serve"] }
```

Claude Code: `claude mcp add tokmeter --scope user -- npx -y @sriinnu/tokmeter-mcp serve`.

All tools are prefixed `tokmeter_`. Start with `tokmeter_pulse` — it answers most
"what am I spending" questions in one call. Full list grouped by purpose:
[MCP tool reference](https://github.com/sriinnu/tokmeter/blob/main/docs/mcp-tools.md).

**Cleanup is gated server-side.** `tokmeter_cleanup_execute` refuses to run
unless passed `confirm: "DELETE"` and writes a backup first by default; always
call `tokmeter_cleanup_preview` first. The human "are you sure?" over MCP comes
from your client's tool-approval UI, not from inside the server. See
[Backup & restore](https://github.com/sriinnu/tokmeter/blob/main/docs/backup-restore.md#confirmation-and-backup-where-the-gate-lives).

## Daemon HTTP

`tokmeter-mcp daemon start` runs a warm core so repeated reads never re-scan the
corpus. Read-only JSON on `127.0.0.1:9877` (WebSocket `9876` is for live session
registration, not queries):

| Endpoint | Returns |
| --- | --- |
| `/api/ready` | Whether the warm core finished loading |
| `/api/quick` | Lifetime totals + live signals — cheapest poll |
| `/api/today` | Today's totals and per-project split |
| `/api/summary` | The full `TokmeterSummary` |
| `/api/stats`, `/api/daily`, `/api/models`, `/api/providers`, `/api/projects`, `/api/sessions` | Scoped aggregates |
| `/api/statbar-signals` | Burn rate, cache hit, pace, billing window |
| `/api/coverage` | The last week's coverage reports: session files that changed on a sealed day and fed no usage (1.17.0+) |
| `/api/rates` | Per-model $/M rates (input, output, cache read/write) with the price source; `?scope=all` for every model with usage |

> **Never run a full scan in a loop.** A full corpus scan is memory-heavy;
> anything polling more than once a minute should read the daemon or the MCP
> server, which hold warm state.
