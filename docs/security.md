# Security and privacy

What Tokmeter reads, what leaves your machine, and how to check both. This page
describes 1.21.0 and later.

## What it reads on your machine

- **Session files and local databases your agents already wrote**, such as
  `~/.claude/projects/`, `~/.codex/sessions/`, `~/.dsh/sessions/` and OpenCode's
  SQLite database. [Integrations](compatibility.md) lists them by agent.
- **Its own files**: `~/.tokmeter/` for settings, aliases and the daemon token,
  and `~/.cache/tokmeter/` for the ledger, caches and backups.
- **Kosha's price catalog**: `~/.kosha/registry.json` and
  `~/.kosha/catalog-only.json`.

It doesn't read API keys or provider CLIs to price usage. Tokmeter asks kosha
for keyless discovery only.

## What leaves your machine

Your usage data doesn't. There's no telemetry and no account.

Tokmeter does download public price catalogs, and it does this without being
asked. The daemon, or any command that prices usage, refreshes them when the
saved copy is more than about a day old, and retries at most hourly after a
failure. `tokmeter update` and the bar's price refresh do the same on request.
`--light` skips pricing and the refresh for that one command. It has no effect
on the daemon, which keeps refreshing on its own schedule.

<!-- HOSTS -->
Measured on 2026-11-04 with kosha 1.13.0, by wrapping `fetch` during a real
keyless discovery on a temporary home with fake API keys in the environment. No
credential was sent. A future kosha version could change this list.

| Host | Why |
| --- | --- |
| `models.dev` | Public model and price catalog |
| `raw.githubusercontent.com` | LiteLLM's public price catalog |
| `openrouter.ai` | OpenRouter's public model list |
| `ai-gateway.vercel.sh` | Vercel AI Gateway's public model list |
| `127.0.0.1:1234`, `127.0.0.1:8000`, `127.0.0.1:8080`, `localhost:11434` | Local checks for model runtimes you may run. These stay on your machine |

If both community catalogs are unreachable, kosha falls back to its own
published snapshot on GitHub:
`github.com/sriinnu/kosha-discovery/releases/download/snapshot-latest/kosha-latest.json`.
That path comes from the source. The measured run didn't need it.

Those requests reveal your IP address and when you refresh, as any download
does. They carry nothing about your usage.

The macOS app also checks its update feed on GitHub through Sparkle, and links
such as Releases open in your browser.

**Outside Tokmeter's control:** a separately installed kosha MCP server or CLI
uses your API keys if it finds them, and it writes to the same
`~/.kosha/registry.json`. Tokmeter reads that file, so prices can come from such
a run. Tokmeter never sends those keys itself.

### Check it yourself

```sh
lsof -nP -a -p "$(cat ~/.tokmeter/daemon/daemon.pid)" -iTCP   # the daemon's sockets
tokmeter models --today --light                               # no pricing, no refresh
```

## The daemon

The daemon listens on `127.0.0.1` only: HTTP on port 9877 and WebSocket on port
9876.

Every route except `/api/ready` needs the bearer token in
`~/.tokmeter/daemon/daemon.token`. The directory is mode 0700 and the file 0600
on macOS and Linux. `/api/ready` reveals only whether the daemon has loaded.

The token separates you from other accounts on the machine. It doesn't separate
you from your own programs: anything running as you can read the token and call
the daemon. It can then read your usage and trigger a rescan or a price refresh.

**The daemon can't delete anything.** It has no cleanup or restore route.
Deleting and restoring run from the terminal or the TUI, and the 22 MCP tools
are read-only. Releases before 1.21.0 had token-gated POST routes for cleanup and
restore that nothing in the repository called.

## Antigravity live polling

Antigravity keeps no per-session cost on disk, so its credit status comes from
its running process. Doing that means reading a CSRF token from the process list
(`ps`, `lsof`) and calling Antigravity's undocumented local RPC. Nothing leaves
the machine.

- **Background polling** is off by default. It needs
  `tokmeter config set daemon.antigravityLivePolling true`.
- **The manual fetch** is a one-off, whatever that setting says. It runs when you
  press its button or POST to `/api/antigravity-live/fetch`, which needs the
  daemon token.

## Agents reading Tokmeter's output

Project names, model names and paths come from local transcripts, so they can
contain text written to look like instructions. Tokmeter strips control sequences
and marks these sections as untrusted, but it can't make such text harmless. MCP
hosts should keep tool output out of privileged prompts. See
[MCP tools](mcp-tools.md).

## How releases are signed

- **Git:** release tags and commits are signed with a hardware key. Check with
  `git tag -v vX.Y.Z`.
- **npm:** CI stages each package through Trusted Publishing with provenance, and
  there's no `NPM_TOKEN`. A version goes live only after a maintainer approves it
  with a security key. Check with `npm audit signatures`.
- **macOS app:** Developer ID signed, hardened runtime, notarized and stapled.
  Check with `spctl -a -vv -t exec /Applications/TokmeterBar.app`.
- **App updates:** each update is signed with an EdDSA key, and the app verifies
  it against the public key embedded in it.

## Third-party logos

The menu bar app bundles agent logos from
[lobe-icons](https://github.com/lobehub/lobe-icons) (MIT), compiled into the app.
It doesn't fetch them. The licence is in the app at
`Contents/Resources/Licenses/AgentLogos.md`. The marks stay with their owners and
only show which agent a row came from.

## Outside audits

[Agent Trust Hub](https://www.skills.sh/) scanned Tokmeter's agent skill on
2026-10-29, at two listings:

| Listing | Result |
| --- | --- |
| `sriinnu/tokmeter-skill`, where the skill lives now | Pass, risk level SAFE. It notes the LaunchAgent the daemon can install and that transcripts are an indirect prompt-injection surface |
| `sriinnu/tokmeter/tokmeter`, the old location | Fail, risk level HIGH |

The old listing's findings, against the code at that scan:

- **Remote code execution:** a `curl … | node` line in `scripts/release.sh`. That
  line is gone.
- **Persistence:** the daemon's and daily price job's LaunchAgents. Both are real,
  and you install them yourself.
- **Credential access:** the Antigravity CSRF read, described above.
- **Command execution:** `ps`, `lsof`, `launchctl`, `tar` and `sqlite3`. Real and
  needed.
- **Indirect prompt injection:** transcripts. Real, and described above.

Neither page offers a way to request a rescan, so the old listing may keep saying
Fail.

## Reporting a problem

Open an issue at <https://github.com/sriinnu/tokmeter/issues>. For anything
sensitive, say so there without the details and ask for a private channel.
