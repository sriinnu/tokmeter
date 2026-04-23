# @sriinnu/tokmeter-core

Core engine for token usage tracking. Provides session parsers for 16+ AI agent formats, token aggregation, and model pricing via kosha-discovery.

## Capabilities

- Parse session files from Claude Code, Codex, Cursor, Gemini, OpenCode, and 11 more providers
- Aggregate tokens by project, model, provider, and time period
- Enrich records with accurate pricing (input, output, cache, reasoning tokens)
- 4-tier pricing: kosha direct, static table, kosha fuzzy, null
- Filter by date range, provider, project

## API

```typescript
import { TokmeterCore } from "@sriinnu/tokmeter-core";
const core = new TokmeterCore();
const records = await core.scan({ today: true });
const stats = core.getStats();
const models = core.getModelCosts();
const daily = core.getDailyBreakdown();
```
