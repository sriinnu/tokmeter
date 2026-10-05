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

### "The cost seems off"

Estimated cost is **not a bill**. Where a tool reports its own cost, that's used;
otherwise cost is derived from token counts and a public price catalog.
Long-context tiers, negotiated rates and subscription plans are not modeled.
Lifetime totals also mix pricing eras — prefer `today`/`week`/`month` when
showing a number to a human.

### Pricing shows as stale

The price catalog ("kosha") refreshes on a schedule. Only **today** reprices
when the catalog updates; past days stay frozen by design. Force a refresh from
the bar's settings or re-run the daily refresh.

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
