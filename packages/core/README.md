<p align="center">
  <img src="../../logo.svg" alt="tokmeter" width="80" />
</p>

<h1 align="center">@tokmeter/core</h1>

<p align="center"><strong>Session parsers, aggregation, and pricing for 16+ AI coding agents</strong></p>

---

The engine behind tokmeter. Scans local session files, parses token records from 16+ AI agent formats, enriches them with model pricing via [`@sriinnu/kosha-discovery`](https://www.npmjs.com/package/@sriinnu/kosha-discovery), and exposes a clean API for aggregation.

## Install

```bash
npm install @tokmeter/core
```

## Usage

```typescript
import { TokmeterCore } from "@tokmeter/core";

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

## License

MIT
