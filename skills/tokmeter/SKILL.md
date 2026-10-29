---
name: tokmeter
description: >-
  Report token usage and estimated cost for AI coding agents (Claude Code, Codex, Cursor, Gemini CLI and 20 more) by project, model, provider and day, read locally from the session files those agents write. Use when the user asks what they spent, which model or project costs most, how usage is trending, or wants a budget check; also when building an app or automation that needs that telemetry.
license: AGPL-3.0-only
compatibility: Node.js 18+. Reads local agent session files; no API key. The only network use is an optional public price-catalog fetch, which --light skips.
---

# tokmeter

Use Tokmeter when an app, agent, or automation needs local token and cost
telemetry for AI coding assistants — spend by project, model, provider and day,
read from the session files those tools already write to disk. No hosted
backend, no API keys, no telemetry leaving the machine.

## Read this before reporting a number

Tokmeter is an accounting tool, so a wrong number is worse than no number.
Three things shape what its answers mean:

- **Sealed days are frozen at the prices of the day they were sealed.** Cost
  history is a ledger, not a re-computation. Updating a price list does not
  restate yesterday. Only today reprices.
- **Lifetime totals mix pricing eras** and can include days sealed by older
  parsers. Prefer `today` / `week` / `month` scopes when a number will be shown
  to a human as "what this costs". Say "lifetime, as recorded" rather than
  "lifetime spend" if you must report it.
- **Estimated cost is not a bill.** Where a tool reports its own cost, that is
  used; otherwise cost is derived from token counts and a public price catalog.
  Long-context tiers, negotiated rates and subscription plans are not modeled.
  Report it as an estimate.

`docs/how-the-numbers-work.md` is the authority on bucket semantics.

## Pick the right surface

The single most important choice is **one-shot versus repeated** reads.

| Need | Use | Why |
| --- | --- | --- |
| Live or repeated answers inside an agent | **MCP server** (`@sriinnu/tokmeter-mcp`) | Reads the warm daemon; no corpus scan per question |
| Live or repeated answers from any language | **Daemon HTTP** on `127.0.0.1:9877` | Same warm state, plain JSON, no Node dependency |
| One-shot report in a script or CI | `npx @sriinnu/tokmeter --json` | Stable machine-readable contract, no code to write |
| One reusable in-process scan (Node/Bun) | `@sriinnu/tokmeter` | Lowest-level API: scan, aggregate, price, cleanup, restore |
| Convenience wrappers around common queries | `@sriinnu/tokmeter/cli` | summary, project, model, daily, stats, pricing, digest helpers |
| Human exploration | `tokmeter-tui`, the macOS app, or the web dashboard | Interactive inspection |

> **Do not call `TokmeterCore.scan()` in a loop, a poll, or a hot path.** A full
> scan parses the whole corpus and is memory-heavy; repeating it has caused
> machine-level memory exhaustion. Scan once and reuse the instance, or read the
> daemon. Anything that runs more than once a minute should read the daemon.

## MCP (preferred for agents)

Published in the official MCP registry as **`io.github.sriinnu/tokmeter`**,
shipped in the npm package `@sriinnu/tokmeter-mcp`. The default command starts a
terminal UI, so the MCP entry point is the `serve` subcommand:

```json
{ "command": "npx", "args": ["-y", "@sriinnu/tokmeter-mcp", "serve"] }
```

Tools are prefixed `tokmeter_`. Start with `tokmeter_pulse`; it answers most
"what am I spending" questions in one call.

| Group | Tools |
| --- | --- |
| Overview | `tokmeter_pulse`, `tokmeter_digest`, `tokmeter_timeline`, `tokmeter_heatmap`, `tokmeter_streaks` |
| Breakdowns | `tokmeter_models`, `tokmeter_providers`, `tokmeter_projects`, `tokmeter_search` |
| Analysis | `tokmeter_compare`, `tokmeter_forecast`, `tokmeter_efficiency`, `tokmeter_leaderboard`, `tokmeter_anomaly`, `tokmeter_cache_efficiency` |
| Advice | `tokmeter_model_advisor`, `tokmeter_cost_optimization_tips`, `tokmeter_budget`, `tokmeter_budget_alert` |
| Data management | `tokmeter_export`, `tokmeter_backups`, `tokmeter_cleanup_preview` |

Every MCP tool is read-only. `tokmeter_cleanup_preview` shows what a cleanup
would delete, but deleting and restoring are not available over MCP: the user
runs `tokmeter cleanup` / `tokmeter restore` in a terminal, which previews
again, writes a backup, and asks for confirmation.

## Daemon HTTP

Start it with `tokmeter-mcp daemon start`; `daemon status`, `daemon stop`, and
`daemon restart` manage it. On macOS, `tokmeter-mcp daemon install-agent`
installs a launchd LaunchAgent (`RunAtLoad` + crash-respawn) so it auto-starts
at login and survives reboots — the robust way to keep it always-on. Read-only
JSON on `127.0.0.1:9877` (WebSocket on `9876` is for live session registration,
not queries). Since 1.19.2 every route except `/api/ready` needs
`Authorization: Bearer <token>`, with the token read at request time from
`~/.tokmeter/daemon/daemon.token`; never log it or pass it as a command argument:

| Endpoint | Returns |
| --- | --- |
| `/api/ready` | Whether the warm core has finished loading |
| `/api/quick` | Lifetime totals plus live signals — cheapest poll |
| `/api/today` | Today's cross-provider totals and per-project split |
| `/api/summary` | The full `TokmeterSummary` contract |
| `/api/stats`, `/api/daily`, `/api/models`, `/api/providers`, `/api/projects`, `/api/sessions` | Scoped aggregates |
| `/api/statbar-signals` | Burn rate, cache hit, pace, billing window |
| `/api/health`, `/api/pricing-status`, `/api/cron-status` | Daemon, pricing-freshness, and cron health |
| `/api/today-models`, `/api/cross-tool`, `/api/anomalies`, `/api/session-ledger` | Today's models, cross-tool projection, anomalies, and the per-session ledger |
| `/api/backups`, `/api/themes` | Cleanup backups and available bar themes |
| `/api/quota` | Plan windows per agent (Codex weekly, Claude Code 5h and 7d): used %, reset time, and whether the current pace runs out first |
| `/api/coverage` | The last week's coverage reports: session files that changed on a sealed day and fed no usage |
| `/api/rates` (`?scope=all`) | Per-model list price per million tokens (input, output, cache read/write), the price source, and the effective rate. Added after v1.14.1 |

An unknown path returns `{"error":"Not found","endpoints":[…]}` listing the
primary routes — a useful index, though a few specialized endpoints above aren't
in it, so treat it as a starting point rather than the complete surface. Check
`/api/ready` before trusting a cold read.

## Shell and CI

```bash
npx @sriinnu/tokmeter --today --json
npx @sriinnu/tokmeter models --json --project tokmeter
npx @sriinnu/tokmeter digest --json --period week
```

Filters: `--project`, `--claude`, `--codex`, `--week`, `--month`,
`--since YYYY-MM-DD --until YYYY-MM-DD`. `--light` skips pricing lookups when
token counts alone are enough — use it when you do not need dollars.

## Custom sources (agents with no built-in parser)

For an agent tokmeter does not ship a parser for — one you built, or a tool not
yet covered — register a directory in `~/.tokmeter/config.json` and have the
agent emit one JSON object per API response in the canonical usage-line format:

```json
"customSources": [
  { "path": "~/.ribhu/usage", "format": "tokmeter-usage-jsonl", "provider": "ribhu" },
  { "path": "~/.chitragupta/usage", "format": "tokmeter-usage-jsonl", "provider": "chitragupta" }
]
```

Each line (snake_case or camelCase; token buckets flat or nested under `usage`):

```json
{"ts": 1790000001000, "id": "<response-id>", "model": "<resolved-model>",
 "cwd": "/abs/project",
 "usage": {"input_tokens": 1000, "output_tokens": 100, "cache_read_tokens": 10,
           "cache_write_tokens": 0, "reasoning_tokens": 0}}
```

The config entry's `provider` is the AGENT (`ribhu`, `chitragupta`, `grok`, or
`custom`), and
every record is tagged with it; `model` is the resolved model, so pricing works
even when the agent routes across models per response. `input_tokens` is
uncached (Anthropic-style).

A line MAY also carry `"provider"`: the routed vendor that served that response
(`"deepseek"`, `"ollama"`, …). It never replaces the agent tag. It only marks a
locally served response — `ollama`, `lmstudio`, `llamacpp`, `llama.cpp`, `mlx`
— as a known $0 instead of missing pricing (Ollama `-cloud` models excluded,
they bill). A positive `cost` on a line is kept as a floor.

A router that makes model calls for other agents (Chitragupta) must not write
a line for a call whose caller meters itself (Ribhu), or that response is
counted twice.

## Backfill (pick up newly added parsers / sources into history)

A plain scan only reads today's raw plus the sealed relay; a new parser or
custom source does not appear in already-sealed days until backfilled.

```bash
npx @sriinnu/tokmeter backfill --muse --days 30    # SURGICAL: add only this
                                                   # provider's slice to each
                                                   # sealed day; others untouched
npx @sriinnu/tokmeter backfill --days 30           # FULL: re-derive all
                                                   # providers (grow-only)
```

Surgical backfill is the safe tool when a day's *other* providers' raw has aged
out (a full re-derive would shrink and be rejected, or lose them with `--force`).
It is additive, idempotent (re-runs skip already-present provider days), never
touches today, and is bounded by how far the target's own raw still exists.

## In-process (Node / Bun)

```ts
import { TokmeterCore } from "@sriinnu/tokmeter";

const core = new TokmeterCore();
await core.scan();                    // once — never per request
const summary = core.getSummary({ providers: ["claude-code", "codex"], week: true });
const models = core.getModelCosts();
```

Convenience helpers, if you would rather not manage an instance:

```ts
import {
	loadTokmeterSummary,
	loadTokmeterProjects,
	loadTokmeterStats,
	lookupTokmeterPricing,
} from "@sriinnu/tokmeter/cli";

const summary = await loadTokmeterSummary({ month: true });
const stats = await loadTokmeterStats({ week: true, light: true });
const pricing = await lookupTokmeterPricing("claude-opus-5");
```

## Contract notes

- `TokmeterSummary` is the high-level contract for downstream apps.
- **`scan(options)` does not filter later getters.** Scope each report with
  `getSummary(options)`; a no-argument getter after a filtered scan returns
  everything.
- Reports use **inclusive local calendar days**; `week` means today plus the
  previous six. Timestamps are rejected — pass dates.
- `summary.records` is a **rolling recent window of raw evidence**, not the
  historical ledger. Sum aggregates, never `records`, for history.
- An explicit zero from a tool is preserved as zero. A missing price surfaces
  as unavailable rather than as `$0` — do not render unknown as free.
- Cache reads, cache writes, input, output and reasoning are separate buckets.
  Sub-buckets (such as the 1-hour share of cache writes) are **subsets** of
  their parent and must never be added into a total.

## Packages

`@sriinnu/tokmeter` (core API, CLI, TUI) and `@sriinnu/tokmeter-mcp` (MCP server,
daemon, statusline) are the published surfaces. `packages/core`, `cli`, `tui`
and `web` are private implementation packages — do not depend on them directly.

## References

- `README.md` — overview and install
- `docs/how-the-numbers-work.md` — bucket semantics and where estimates enter
- `docs/consuming-tokmeter.md` — integration guidance
- `docs/architecture.md` — daemon lifecycle, storage, refresh
- `packages/core/src/index.ts`, `packages/mcp/src/index.ts` — exported surfaces

## Licenses

Applications are AGPL-3.0-only; core source is MPL-2.0. See
[licenses and source](https://github.com/sriinnu/tokmeter/blob/main/docs/licensing.md).
