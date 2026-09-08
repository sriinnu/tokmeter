# Consuming Tokmeter from Other Apps

Use this guide when another AI project, CLI, service, or editor integration needs Tokmeter data.

## Pick the right surface

| Need | Use | Why |
| --- | --- | --- |
| Local programmatic access in Node/Bun | `@sriinnu/tokmeter` | Lowest-level API with full scan, aggregation, filtering, cleanup, and pricing access |
| Shell automation / CI / scripting | `npx @sriinnu/tokmeter --json` | Stable shell entrypoint that emits machine-readable JSON |
| Convenience helpers without shelling out | `@sriinnu/tokmeter/cli` imports | Wraps the common summary/project/model/stats queries |
| Live token telemetry from an AI agent | `@sriinnu/drishti` | MCP server, daemon, live tracker, and statusline surface |
| Human exploration | `npx -p @sriinnu/tokmeter tokmeter-tui` or the web workspace | Best for interactive/manual use, not for automation |

## Canonical published package names

The published packages are `@sriinnu/tokmeter` and `@sriinnu/drishti`.
Use `@sriinnu/tokmeter` for the core API and `@sriinnu/tokmeter/cli` for convenience helpers.
The core, CLI, TUI, and web workspace packages are private implementation packages.

## Recommended integration order

1. If your tool can speak MCP, use `@sriinnu/drishti`.
2. If you need batch automation or CI checks, use `npx @sriinnu/tokmeter --json`.
3. If you need embedded logic in Node/Bun code, use `@sriinnu/tokmeter` directly.
4. If you want convenience wrappers around common queries, import from `@sriinnu/tokmeter/cli`.

## Shell / CI integration

### Full summary

```bash
npx @sriinnu/tokmeter --json
```

This returns the same summary shape used by the web dashboard:

- `records`
- `projects`
- `models`
- `daily`
- `stats`
- `meta`

### Focused queries

```bash
npx @sriinnu/tokmeter projects --json
npx @sriinnu/tokmeter models --json --project tokmeter
npx @sriinnu/tokmeter stats --json --month
npx @sriinnu/tokmeter digest --json --period week
```

## Convenience helpers from `@sriinnu/tokmeter/cli`

```ts
import {
  loadTokmeterSummary,
  loadTokmeterProjects,
  loadTokmeterModels,
  loadTokmeterStats,
  lookupTokmeterPricing,
  runDigest,
  runCleanup,
  runRestore,
} from "@sriinnu/tokmeter/cli";

const summary = await loadTokmeterSummary({ month: true });
const projects = await loadTokmeterProjects({ project: "command-relay" });
const models = await loadTokmeterModels({ providers: ["codex"] });
const stats = await loadTokmeterStats({ light: true, week: true });
const pricing = await lookupTokmeterPricing("claude-sonnet-4-20250514");
```

Use these wrappers when you want the convenience of the CLI package but not the overhead of spawning a subprocess.

## Direct core usage

```ts
import { TokmeterCore } from "@sriinnu/tokmeter";

const core = new TokmeterCore();
await core.scan();

const summary = core.getSummary({ since: "2026-04-01", providers: ["codex", "claude-code"] });
const projects = summary.projects;
const stats = summary.stats;
```

Use core directly when you need:

- one scan reused across multiple queries
- cleanup or restore services
- low-level filtering/aggregation helpers
- control over caching and pricing lifecycle

## Report filters and retained history

CLI reports, the convenience helpers, and `core.getSummary(options)` filter saved daily aggregates together with today's live aggregate. Calling `scan(options)` alone does not scope later no-argument getters. Those getters keep their all-time view.

Report dates use the machine's local calendar: `week` means today and the previous six days, `month` means the current month through today, and `year` means the selected calendar year. `since` and `until` accept inclusive `YYYY-MM-DD` bounds. Intraday timestamps are rejected because saved daily history cannot reconstruct partial days. Report `--older-than` selects complete days before the cutoff date; destructive cleanup retains its timestamp cutoff. The lower-level raw `scan()` API retains its separate timestamp filtering.

Project filters match raw names or alias display names; provider and date filters intersect with that selection. Hidden projects stay out of project lists but remain in totals. `records` contains only the available recent raw records and their original provenance; it is not a reconstruction of all historical records contributing to the totals.

Scan metadata describes the full refresh. Narrowed reports omit rolling live signals, whose time windows differ from the report. With project/provider filtering, first/last timestamps retain the original project-day bounds; per-provider intraday boundaries are not available in the saved cross-cut buckets. Costs retain their saved values and may lack provenance for a retrospective estimate/report split.

## MCP / live integrations

Use `@sriinnu/drishti` when an AI assistant should answer token/cost questions during a session.

- MCP server: tool-based queries
- daemon: cross-provider live aggregation
- statusline: inline live spend view
- `LiveTracker`: event-driven programmatic live snapshots

## Contract notes

- Tokmeter reads local session files; it does not require a hosted backend.
- Pricing can be skipped with `light` / `--light` when speed matters more than dollar values.
- CLI JSON is the safest shell-facing contract.
- `TokmeterSummary` is the best high-level data contract for dashboards and downstream apps.
- Drishti is the best surface for live, in-session AI integrations.

## See also

- `README.md`
- `SKILL.md`
- `packages/core/src/index.ts`
- `packages/mcp/src/index.ts`

## Licenses

Applications use AGPL-3.0-only; core source uses MPL-2.0. See [licenses and source](licensing.md).
