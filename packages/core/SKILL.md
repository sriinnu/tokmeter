# @sriinnu/tokmeter-core

Private workspace package. Use the public `@sriinnu/tokmeter` distribution.

Core engine for token usage tracking. Provides session parsers for 16+ AI agent formats, token aggregation, and model pricing via kosha-discovery.

## Capabilities

- Parse session files from Claude Code, Codex, Cursor, Gemini, OpenCode, and 11 more providers
- Aggregate tokens by project, model, provider, and time period
- Enrich records with estimated API pricing (input, output, cache, reasoning tokens)
- Pricing: user overrides, kosha direct/fuzzy lookup, registry manifest fallback, or unavailable
- Filter by date range, provider, project

## API

```typescript
import { TokmeterCore } from "@sriinnu/tokmeter";
const core = new TokmeterCore();
const records = await core.scan({ today: true });
const stats = core.getStats();
const models = core.getModelCosts();
const daily = core.getDailyBreakdown();
```

## License

MPL-2.0; see [licenses and source](../../docs/licensing.md).
