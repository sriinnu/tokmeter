# Consuming Tokmeter from Other Apps

Use this guide when another AI project, CLI, service, or editor integration needs Tokmeter data.

## Pick the right surface

| Need | Use | Why |
| --- | --- | --- |
| Local programmatic access in Node/Bun | `@sriinnu/tokmeter-core` | Lowest-level API with full scan, aggregation, filtering, cleanup, and pricing access |
| Shell automation / CI / scripting | `@sriinnu/tokmeter-cli` with `--json` | Stable shell entrypoint that emits machine-readable JSON |
| Convenience helpers without shelling out | `@sriinnu/tokmeter-cli` imports | Wraps the common summary/project/model/stats queries |
| Live token telemetry from an AI agent | `@sriinnu/drishti` | MCP server, daemon, live tracker, and statusline surface |
| Human exploration | `@sriinnu/tokmeter-tui` or `@sriinnu/tokmeter-web` | Best for interactive/manual use, not for automation |

## Canonical published package names

Always use the published names below. Older shorthand like `@tokmeter/*` is not the canonical npm scope.

- `@sriinnu/tokmeter-core`
- `@sriinnu/tokmeter-cli`
- `@sriinnu/tokmeter-tui`
- `@sriinnu/tokmeter-web`
- `@sriinnu/drishti`

## Recommended integration order

1. If your tool can speak MCP, use `@sriinnu/drishti`.
2. If you need batch automation or CI checks, use `@sriinnu/tokmeter-cli --json`.
3. If you need embedded logic in Node/Bun code, use `@sriinnu/tokmeter-core` directly.
4. If you want convenience wrappers around common queries, import from `@sriinnu/tokmeter-cli`.

## Shell / CI integration

### Full summary

```bash
npx @sriinnu/tokmeter-cli --json
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
npx @sriinnu/tokmeter-cli projects --json
npx @sriinnu/tokmeter-cli models --json --project tokmeter
npx @sriinnu/tokmeter-cli stats --json --month
npx @sriinnu/tokmeter-cli digest --json --period week
```

## Convenience helpers from `@sriinnu/tokmeter-cli`

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
} from "@sriinnu/tokmeter-cli";

const summary = await loadTokmeterSummary({ month: true });
const projects = await loadTokmeterProjects({ project: "command-relay" });
const models = await loadTokmeterModels({ providers: ["codex"] });
const stats = await loadTokmeterStats({ light: true, week: true });
const pricing = await lookupTokmeterPricing("claude-sonnet-4-20250514");
```

Use these wrappers when you want the convenience of the CLI package but not the overhead of spawning a subprocess.

## Direct core usage

```ts
import { TokmeterCore } from "@sriinnu/tokmeter-core";

const core = new TokmeterCore();
await core.scan({ since: "2026-04-01", providers: ["codex", "claude-code"] });

const summary = core.getSummary();
const projects = core.getAllProjects();
const stats = core.getStats();
```

Use core directly when you need:

- one scan reused across multiple queries
- cleanup or restore services
- low-level filtering/aggregation helpers
- control over caching and pricing lifecycle

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
