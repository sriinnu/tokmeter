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
| OpenCode, Amp, Droid, OpenClaw, Pi, Kimi, Kilo, Kilo CLI, Mux, Synthetic | Implemented; not individually validated in this candidate | Generic aggregation tests do not establish current parser compatibility. Treat as provisional until a local numeric sample is checked. |

## Keeping this table current

1. Capture only structural event fields and numeric usage, with synthetic identifiers and project names.
2. Add a regression fixture for any newly observed format. The [current Codex fixture](../packages/core/src/parsers/fixtures/codex-response-usage.json) is an example.
3. Verify totals independently of the parser and test duplicate/replay behavior.
4. Record the observation date and what was actually checked. Do not promote fixture-only coverage to live verification because tests passed.

The suite retains pre-existing TODO tests. A passing run is evidence for the tested behavior, not a blanket compatibility certificate.
