<p align="center">
  <img src="../../logo.svg" alt="tokmeter" width="80" />
</p>

<h1 align="center">@sriinnu/tokmeter-core</h1>

<p align="center"><strong>Session parsers, aggregation, and pricing for 16+ AI coding agents</strong></p>

---

The engine behind tokmeter. Scans local session files, parses token records from 16+ AI agent formats, enriches them with model pricing via [`@sriinnu/kosha-discovery`](https://www.npmjs.com/package/@sriinnu/kosha-discovery), and exposes a clean API for aggregation.

## Install

```bash
npm install @sriinnu/tokmeter-core
```

## Usage

```typescript
import { TokmeterCore, sumUsage } from "@sriinnu/tokmeter-core";

const core = new TokmeterCore();
const records = await core.scan();

// Per-project breakdown
const projects = core.getAllProjects();
const myProject = core.getProjectSummary("my-app");

// Per-model costs
const models = core.getModelCosts({ project: "my-app" });

// Daily trend
const daily = core.getDailyBreakdown({ since: "2025-01-01" });

// Overall stats
const stats = core.getStats();
console.log(`$${stats.totalCost.toFixed(2)} across ${stats.projects} projects`);

// Derived usage math works across every parser's canonical buckets.
const usage = sumUsage(records);
console.log(`Cache hit: ${(usage.cacheHitRate * 100).toFixed(1)}%`);
```

## Supported Providers

Claude Code, OpenCode, Codex CLI, Gemini CLI, Cursor, Amp, Droid, OpenClaw, Pi, Kimi, Qwen, Roo Code, Kilo, Kilo CLI, Mux, Synthetic.

## Pricing

4-tier resolution:
1. **kosha direct** -- `registry.model(id)` with API keys
2. **Static table** -- 50+ models with accurate direct-API rates
3. **kosha fuzzy** -- 300+ OpenRouter models for the long tail
4. **null** -- unpriced

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

MIT
