# Troubleshooting

Common symptoms and what they mean. Tokmeter is an accounting tool, so when a
number looks wrong the first question is always *which* number — a live display,
or the durable ledger. They are not the same thing.

## The menubar bar

### "The update is improperly signed and could not be validated"

The copy of TokmeterBar you're running has no Sparkle public key embedded (or a
mismatched one), so it can't validate **any** update signature — including a
perfectly valid release. This happens when the installed app was a local/dev
build rather than the notarized release.

**Fix:** install the real notarized build — `brew upgrade --cask tokmeterbar`,
or download `TokmeterBar-<version>.zip` from the
[releases page](https://github.com/sriinnu/tokmeter/releases) and replace the app
in `/Applications`. From a correctly-signed build onward, auto-update works.

As of **1.14.1**, a build produced without a signing key no longer advertises
auto-update at all, so it can't produce this error again — only properly signed
releases ever point at the appcast.

### The bar shows "?", "offline", or zeros

The daemon isn't answering. Check and start it:

```bash
tokmeter-mcp daemon status
tokmeter-mcp daemon start
```

On macOS, install the always-on LaunchAgent so it starts at login and respawns
on crash:

```bash
tokmeter-mcp daemon install-agent
```

A bar that shows "offline" while the daemon is actually healthy is usually a
stale `/tmp` pidfile; the daemon self-heals within ~10s, or `daemon restart`
forces it.

If the daemon is running but not answering (the bar stays on "?" and
`curl http://127.0.0.1:9877/api/ready` times out), restart it with
`tokmeter-mcp daemon restart`. Under the LaunchAgent that is the same as
`launchctl kickstart -k gui/$(id -u)/com.tokmeter.daemon`.

## The statusline

### The statusline is blank, or shows `~` and an age

Claude Code cancels a statusline that hasn't printed by its next update,
about 300 ms while a turn is running. Before **1.16.0** the statusline waited
up to 1.5 s for the daemon, so on a busy machine many renders were cancelled
and the line stayed empty.

Since 1.16.0 it never waits more than about 300 ms. If the daemon hasn't
answered, it shows the last good totals dimmed with their age, for example
`today ~$138 2m old`. That number is real but not current; it catches up on
its own. `today — daemon offline` means the daemon isn't running at all, and
the statusline starts it (at most once a minute).

If it stays stale for minutes, run `tokmeter-mcp daemon install-agent` once.
Older LaunchAgents ran the daemon in macOS's Background class, which throttles
its disk access under load; 1.16.0 installs it at normal priority.

## Numbers look wrong

### "My history is shrinking / tokens are disappearing"

Sealed days are **immutable** — they live in `~/.cache/tokmeter/aggregates/` and
are frozen at the prices of the day they were sealed. A normal scan never
re-derives them. If a displayed total dropped, suspect a **display** issue
(daemon in-memory drift, or one project fragmented across subfolders) before a
data-loss one: sum the aggregate files on disk and reconcile. The disk ledger is
almost never wrong.

A genuine shrink only happens on an explicit forced/deep rescan, which is gated
precisely because raw transcripts age out and the relay becomes the only copy.

### A day looks short, or "may be missing usage"

Since 1.17.0 the daemon checks each day after it seals. It looks for session
files that changed that day, carry a real token count, and fed nothing into
the ledger. The warning names the folder, for example
`5 in ~/.codex/archived_sessions`. To see the files:

```bash
tokmeter coverage --date 2026-10-19
```

It exits with code 2 when something is unread. Unread files usually mean the
tool started writing somewhere new, or in a new format, that tokmeter doesn't
read yet. Please open an issue with the folder layout; don't attach the files.
Once a fix ships, `tokmeter backfill --<tool> --days N` adds the missing usage
to sealed days, as far back as the raw files still exist.

### A tool's models are missing (OpenCode, Cursor, Zed, Kilo CLI, …)

Two causes, both fixed in **1.16.0**:

- **OpenCode** moved its history into SQLite (`message.data` JSON). Earlier
  versions queried a table that no longer exists and read only the legacy JSON
  store, so nothing after OpenCode's switch appeared.
- **SQLite-backed sources under Node** (OpenCode, Kilo CLI, Cursor, Zed, Codex
  Desktop, Antigravity) had no SQLite driver in the published package, so the
  daemon and CLI read nothing from them. 1.16.0 uses Node's built-in
  `node:sqlite`, which needs **Node 22.13+** (or 23.4+). On older Node these
  sources stay empty — upgrade Node.

After upgrading, today fills in on its own. Days already sealed need a one-time
backfill, which only adds the missing tool and never touches the others:

```bash
tokmeter backfill --opencode --days 40
```

Backfill reaches only as far back as the tool's raw data still exists.

### A model shows "Unavailable" — or $0.00

"Unavailable" means tokmeter has no price for that model; the tokens are real,
the cost is unknown. **$0.00** means the cost is known to be zero: a free tier
(OpenCode `-free` / `:free` models), a model served on your own machine
(Ollama, LM Studio, llama.cpp, MLX via a custom source), or a tool that
reported zero itself. A subscription or coding plan is not free; it is
estimated at API rates.

### "The cost seems off"

Estimated cost is **not a bill**. Where a tool reports its own cost, that's used;
otherwise cost is derived from token counts and a public price catalog.
Long-context tiers, negotiated rates and subscription plans are not modeled.
Lifetime totals also mix pricing eras — prefer `today`/`week`/`month` when
showing a number to a human.

### Pricing shows as stale

The price catalog ("kosha") is refreshed by the daemon once it's a day old
(since 1.17.0; before that only at daemon start or by the macOS daily job). A
failed refresh, such as when you're offline, is retried an hour later. Only
**today** reprices when the catalog updates (since 1.15.0, also when
`~/.tokmeter/pricing-overrides.json` changes); past days keep the prices they
were billed at. Force a refresh from the bar's settings or with
`tokmeter update`.

## Performance

### High CPU or memory

Never call a full scan in a loop, a poll, or a hot path — a full scan parses the
whole corpus and is memory-heavy. Anything running more than once a minute should
read the **daemon** (`127.0.0.1:9877`) or the MCP server, which hold warm state.

If the daemon itself spikes, a common cause is old session files whose
modification time was bumped (e.g. editing or re-saving old transcripts), making
them look like "today" and forcing re-parses. Tokmeter filters on the path date
to resist this, but editing large old transcripts in place can still trigger a
rescan.

## MCP

### The registry shows an old version

`io.github.sriinnu/tokmeter` keeps every published version in the
[MCP registry](https://registry.modelcontextprotocol.io/v0/servers?search=tokmeter);
a search response lists them all, oldest first. The newest `active` entry is the
latest — don't read the first row as "current." Clients resolve the latest
automatically.

### Cleanup tool deleted more than expected

`tokmeter_cleanup_execute` deletes whole source files; a file can hold records
outside your filter. Always run `tokmeter_cleanup_preview` first and read its
partial-file warnings. Everything is backed up to `~/.cache/tokmeter/backups/`
first (unless you passed `backup: false`) — restore with `tokmeter_restore`
(`confirm: "RESTORE"`). See
[Backup, Snapshot & Restore](backup-restore.md#confirmation-and-backup-where-the-gate-lives).

## See also

- [How the numbers work](how-the-numbers-work.md)
- [Backup, Snapshot & Restore](backup-restore.md)
- [MCP tool reference](mcp-tools.md)
