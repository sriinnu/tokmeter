# tokmeter

Use Tokmeter when another app, agent, or automation needs local token/cost telemetry from AI coding assistants.

## Canonical package names

Always use the published npm scope below.

- `@sriinnu/tokmeter-core`
- `@sriinnu/tokmeter-cli`
- `@sriinnu/tokmeter-tui`
- `@sriinnu/tokmeter-web`
- `@sriinnu/drishti`

## Choose the right surface

| Need | Use | Why |
| --- | --- | --- |
| Embedded programmatic access in Node/Bun | `@sriinnu/tokmeter-core` | Lowest-level API with scan, aggregation, pricing, cleanup, and restore support |
| Shell / CI / script automation | `@sriinnu/tokmeter-cli --json` | Stable machine-readable contract without writing parser code |
| Convenience wrappers around common queries | `@sriinnu/tokmeter-cli` imports | Exposes summary, project, model, daily, stats, pricing, digest, cleanup, and restore helpers |
| Live token/cost answers inside an AI workflow | `@sriinnu/drishti` | MCP server, daemon, statusline, and live tracker APIs |
| Human exploration | `@sriinnu/tokmeter-tui` or `@sriinnu/tokmeter-web` | Best for interactive/manual inspection |

## Recommended integration order

1. If your AI platform can speak MCP, use `@sriinnu/drishti`.
2. If you need batch automation or CI checks, call `@sriinnu/tokmeter-cli --json`.
3. If you need one reusable in-process scan, use `@sriinnu/tokmeter-core`.
4. If you want convenience helpers without shelling out, import from `@sriinnu/tokmeter-cli`.

## Quick examples

### Shell / CI

```bash
npx @sriinnu/tokmeter-cli --json
npx @sriinnu/tokmeter-cli models --json --project tokmeter
npx @sriinnu/tokmeter-cli digest --json --period week
```

### Convenience methods

```ts
import {
	loadTokmeterSummary,
	loadTokmeterProjects,
	loadTokmeterStats,
	lookupTokmeterPricing,
} from "@sriinnu/tokmeter-cli";

const summary = await loadTokmeterSummary({ month: true });
const projects = await loadTokmeterProjects({ project: "command-relay" });
const stats = await loadTokmeterStats({ week: true, light: true });
const pricing = await lookupTokmeterPricing("claude-sonnet-4-20250514");
```

### Direct core usage

```ts
import { TokmeterCore } from "@sriinnu/tokmeter-core";

const core = new TokmeterCore();
await core.scan({ providers: ["codex", "claude-code"], since: "2026-04-01" });
const summary = core.getSummary();
```

## Integration notes

- Tokmeter reads local session files; there is no hosted backend requirement.
- `TokmeterSummary` is the best high-level contract for downstream apps and dashboards.
- `light` / `--light` skips pricing lookups when token counts are enough.
- `@sriinnu/drishti` is the preferred live surface for other AI assistants.

## References

- `README.md`
- `docs/consuming-tokmeter.md`
- `packages/core/src/index.ts`
- `packages/cli/src/index.ts`
- `packages/mcp/src/index.ts`
