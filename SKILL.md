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
| Data management | `tokmeter_export`, `tokmeter_backups`, `tokmeter_cleanup_preview`, `tokmeter_cleanup_execute`, `tokmeter_restore` |

`tokmeter_cleanup_execute` **deletes source session files**. Always run
`tokmeter_cleanup_preview` first and get explicit human confirmation; back up
with `tokmeter_backups` before destructive work.

## Daemon HTTP

Start it with `tokmeter-mcp daemon start`. Read-only JSON on `127.0.0.1:9877`
(WebSocket on `9876` is for live session registration, not queries):

| Endpoint | Returns |
| --- | --- |
| `/api/ready` | Whether the warm core has finished loading |
| `/api/quick` | Lifetime totals plus live signals — cheapest poll |
| `/api/today` | Today's cross-provider totals and per-project split |
| `/api/summary` | The full `TokmeterSummary` contract |
| `/api/stats`, `/api/daily`, `/api/models`, `/api/providers`, `/api/projects`, `/api/sessions` | Scoped aggregates |
| `/api/statbar-signals` | Burn rate, cache hit, pace, billing window |

An unknown path returns `{"error":"Not found","endpoints":[…]}`, so the live
server documents itself. Check `/api/ready` before trusting a cold read.

## Shell and CI

```bash
npx @sriinnu/tokmeter --today --json
npx @sriinnu/tokmeter models --json --project tokmeter
npx @sriinnu/tokmeter digest --json --period week
```

Filters: `--project`, `--claude`, `--codex`, `--week`, `--month`,
`--since YYYY-MM-DD --until YYYY-MM-DD`. `--light` skips pricing lookups when
token counts alone are enough — use it when you do not need dollars.

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
[licenses and source](docs/licensing.md).
