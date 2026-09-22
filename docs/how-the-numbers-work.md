# How Tokmeter's numbers work

Tokmeter reads local usage records and keeps daily summaries. It does not inspect your subscription invoice or reconcile charges with a billing account.

## Tokens

Input, cached input, cache writes, visible output, and reasoning are separate ledger buckets where the source provides enough information. Codex includes cached input within input, and reasoning within output; Tokmeter separates those buckets before summing them.

New Codex response receipts are preferred within a covered turn. Mirrored cumulative events are excluded, repeated response IDs are deduplicated, and a subagent's replay of a parent receipt is excluded. Older turns still use their cumulative counters.

Some tools expose only an activity signal or a lifetime token total. Tokmeter does not invent an input/output breakdown to attach a dollar cost. See [coverage and verification](compatibility.md).

## Costs

| Display | What supports it | What it does not establish |
|---|---|---|
| Estimated API cost | Token buckets multiplied by catalog or local override rates | Your subscription payment or invoice |
| Tool-reported cost | A numeric cost exposed by the local tool | That the provider actually charged that amount |
| Unavailable | Missing rates, missing breakdown, skipped pricing, or absent provenance | That usage was free |

An explicit zero from the tool or a known zero pricing rate is retained. Missing optional cache-read rates currently fall back to 10% of input; reasoning uses output rates unless a dedicated rate exists. Cache writes made with the 1-hour TTL (Claude Code reports the split per response) are billed at the registry's `cacheWrite1hPerMillion` when present, else at 2× input for Claude models — Anthropic's published 1h rule — and at the ordinary write rate for other vendors. These are estimation rules, not provider billing guarantees. Long-context tiers, service tiers, negotiated discounts, and other fees are not fully modeled by the current calculator.

Tokmeter uses kosha's catalog and optional `~/.tokmeter/pricing-overrides.json` overrides. A gateway's rate can be used when a usable origin rate is absent. This is another reason to read the result as an estimate.

Today exposes cost provenance in `/api/statbar-signals`: the estimated and reported amounts, unavailable count, and per-model breakdown. Model/project cost totals may combine different bases. Existing historical rollups do not contain enough provenance for a reliable retrospective split, so normal refreshes retain their original values.

## History and corrections

Completed days are stored in the local relay. Normal refreshes update today's usage and read saved history. A deliberate rescan can rebuild a bounded historical window; retention guards protect against replacing a day with incomplete input. Back up a day before applying a reviewed correction.

## Invariants

These hold the accounting together. Breaking one produces numbers that look
plausible and are wrong, which is the failure mode this project cares most
about.

**One record per API response.** Providers do not write one line per call.
Claude Code writes an assistant turn as a separate JSONL line per content block
— thinking, text, and each parallel tool call — all sharing the response's
usage. Deduplicate on the provider's own per-response identifier (`message.id`
for Claude Code, `payload.response_id` for Codex), never on a timestamp: every
line carries its own.

**Usage is not uniform across a turn's lines.** Subagent transcripts open with a
placeholder usage record and only the final line carries real counts. Keep the
maximum per bucket across a response's lines rather than the first value seen,
and re-price a record whose counts grow.

**Sub-buckets are subsets.** The 1-hour share of cache writes is part of the
cache-write total, not an additional bucket. Adding a subset into a total counts
the same tokens twice and inflates every downstream percentage.

**Sealed days are immutable.** The per-day relay files are the durable ledger
precisely because raw session files age out — for some providers within days. A
rebuild may grow a sealed day; shrinking one requires an explicit forced rescan.
A day whose raw source is gone can never be recomputed, so a forced rescan over
it destroys rather than corrects. Back up before any repair.

**Verify against an independent oracle.** Never confirm Tokmeter's output with
Tokmeter. Build a separate ledger directly from the raw session files,
deduplicated on the provider's response identifier, and compare. A shrinking
total is not evidence of data loss when a parser bug for that provider was just
fixed — it may be the correction.

**Bump `CACHE_VERSION`** in `packages/core/src/parsers/utils.ts` whenever a
parser changes how tokens or cost are derived. Cached records from the previous
logic otherwise survive the fix and keep serving the old numbers.

## Reporting a mismatch

Send the app/agent version, local date and timezone, model, expected token count, displayed token count, and whether the source is CLI or desktop. Start with those numeric facts. Do not upload a whole session transcript, database, API key, or credential file.
