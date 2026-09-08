# Core API

The engine behind tokmeter. Scans local session files, parses token records from 16+ AI agent formats, enriches them with model pricing via [`@sriinnu/kosha-discovery`](https://www.npmjs.com/package/@sriinnu/kosha-discovery), and exposes an API for aggregation.

## Install

This is a private workspace package. Install the public `@sriinnu/tokmeter` distribution.

```bash
npm install @sriinnu/tokmeter
```

## Usage

```typescript
import { TokmeterCore, sumUsage } from "@sriinnu/tokmeter";

const core = new TokmeterCore();
const records = await core.scan(); // today on a new instance; recent records on a warm instance

// Per-project breakdown
const projects = core.getAllProjects();
const myProject = core.getProjectSummary("my-app");

// Per-model costs
const models = core.getModelCosts({ project: "my-app" });

// Daily trend
const daily = core.getDailyBreakdown({ since: "2025-01-01" });

// Lifetime stats, including sealed historical days
const stats = core.getStats();
console.log(`$${stats.totalCost.toFixed(2)} across ${stats.projects} projects`);

// Cache hit rate for the returned recent records, not lifetime history.
const usage = sumUsage(records);
console.log(`Cache hit: ${(usage.cacheHitRate * 100).toFixed(1)}%`);
```

For a scoped report, call `core.getSummary({ week: true, project: "my-app", providers: ["codex"] })` after scanning. No-argument getters retain their all-time view; filters passed only to `scan()` do not scope them. Reports use inclusive local calendar dates; `week` means today plus the previous six days. See [report filters and retained history](../../docs/consuming-tokmeter.md#report-filters-and-retained-history) for record, timestamp, and provenance limits.

## Supported Providers

Claude Code, OpenCode, Codex CLI, Gemini CLI, Cursor, Amp, Droid, OpenClaw, Pi, Kimi, Qwen, Roo Code, Kilo, Kilo CLI, Mux, Synthetic.

## Pricing

After the in-memory cache, pricing resolves through:
1. User overrides in `~/.tokmeter/pricing-overrides.json`.
2. Kosha direct model lookup, preferring usable origin rates over gateway rates.
3. Kosha fuzzy lookup.
4. The kosha registry manifest when runtime discovery lacks a model.
5. `null` when no rate is available.

There is no bundled static pricing table. Public catalog pricing does not require provider credentials. See [how the numbers work](../../docs/how-the-numbers-work.md) for estimation rules and unavailable costs.

Covers: input, output, cache read, cache write, and reasoning tokens.

Every `TokenRecord` also carries optional `usage` provenance so consumers can
distinguish direct provider/tool telemetry from normalized, calculated,
estimated, or not-exposed buckets. Cache rates are derived from canonical
input buckets: `cacheRead / (input + cacheRead + cacheWrite)`.

## Data freshness & immutability

History is **frozen**: anything recorded before today keeps its tokens, usage,
and cost forever. Only *today* (still in flight) re-prices when kosha pricing
changes. The frozen pre-today snapshot is **append-only** across calendar
rollovers — never discarded and re-derived — and a monotonic floor guard
refuses to overwrite it with a materially smaller (partial/failed) rebuild.

For hot paths that only need today, use the warm-path refresh instead of a full
scan — it stat-prunes to files modified today and leaves frozen history
untouched:

```typescript
const core = new TokmeterCore();
await core.scan();          // once: loads frozen history + today

// later (e.g. on a timer) — cheap, reads only today's active files:
await core.refreshToday();
```

A today-only `scan({ today: true })` is likewise mtime-pruned. See
[docs/architecture.md](../../docs/architecture.md) for the full data-freshness,
immutability, and daemon model.

## License

MPL-2.0 — [license text](LICENSE). See [licenses and source](../../docs/licensing.md).
