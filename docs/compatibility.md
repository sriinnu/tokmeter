# Integration coverage and verification

Checked for the 1.10.0 release candidate on 2026-09-06. An implemented parser is not a promise that every current version of that tool is supported.

**Live checked** means local numeric usage was inspected during this release work. **Fixture tested** means the parser is exercised using controlled input. Neither means invoice reconciliation, cross-platform testing, or an exhaustive audit of every historical session.

| Integration | Evidence for this candidate | Scope and limits |
|---|---|---|
| Codex CLI | Live checked + fixtures | New response receipts and legacy cumulative counters; real receipt totals reconciled. Replays and mixed formats covered. |
| Codex Desktop / VS Code | Live checked for response receipts; SQLite fallback fixture tested | New receipts use the granular parser. Opaque SQLite totals are baseline deltas with no invented cost; cannot reconstruct usage before observation. |
| Claude Code | Live numeric reconciliation + fixture coverage in scan/relay tests | Existing day totals preserved during a raw-data rebuild. No paid request or invoice check performed. |
| Cursor | Fixture tested | Local SQLite formats; a current live installation was not validated in this release. |
| Gemini CLI | Fixture tested | Local token buckets; current live installation not validated here. |
| Qwen | Fixture tested | Local usage only; no provider/model completion performed. |
| Roo Code | Fixture tested | Local usage and reported cost when exposed. |
| Zed | Fixture tested | Public-schema-based reader; not claimed as current live verification. |
| VS Code Copilot | Fixture tested | Activity/model metadata; tokens and cost may not be exposed. |
| Antigravity | Fixture tested | Local activity parsing; opaque data is not converted into invented tokens/cost. Optional live-credit path has separate tests, not live verification here. |
| Muse (Meta) | Live numeric reconciliation (summed against raw JSONL — 203 responses exact) + fixture | Counts only `model_completed` events and ignores the `goal_usage_attribution` echo (else double-bills). `input_tokens` is OpenAI-style (cache-inclusive) — cached portion stripped. Project from `workspace_root`. |
| Cline | Live data observed + fixture | `chat_usage` stream, Anthropic-style buckets. The kanban/hub log carries no model or workspace, so model is `unknown` and project falls back to `cline`; cost uses Cline's own figure when present. |
| Augment (Auggie) | Live data observed + fixture | One record per exchange, keep-max across response nodes (placeholder + final pattern). No model id stored → tokens surface, cost pends a model. Project from `repository_root`. |
| Copilot CLI | Live data observed + fixture | Authoritative per-model rollup from the `session.shutdown` event (distinct from the VS Code Copilot parser). `inputTokens` cache-inclusive → stripped. A session with no shutdown event (still open / crashed) contributes nothing — honest under-report, never a double. |
| OpenCode, Amp, Droid, OpenClaw, Pi, Kimi, Kilo, Kilo CLI, Mux, Synthetic | Implemented; not individually validated in this candidate | Generic aggregation tests do not establish current parser compatibility. Treat as provisional until a local numeric sample is checked. |
| Custom sources (Ribhu, Grok, any) | Dispatch + validity gate fixture tested | Agents with no built-in parser, registered via `customSources` in `~/.tokmeter/config.json` and emitting the canonical `tokmeter-usage-jsonl` format (one object per API response). Tagged `ribhu`/`grok`/`custom`; `model` is the resolved model so routed-per-response agents still price. See the SKILL for the line format. |

## Keeping this table current

1. Capture only structural event fields and numeric usage, with synthetic identifiers and project names.
2. Add a regression fixture for any newly observed format. The [current Codex fixture](../packages/core/src/parsers/fixtures/codex-response-usage.json) is an example.
3. Verify totals independently of the parser and test duplicate/replay behavior.
4. Record the observation date and what was actually checked. Do not promote fixture-only coverage to live verification because tests passed.

The suite retains pre-existing TODO tests. A passing run is evidence for the tested behavior, not a blanket compatibility certificate.
