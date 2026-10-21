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

An explicit zero from the tool or a known zero pricing rate is retained. Two zeros are treated as reported rather than unavailable because they are facts: an OpenCode response on an explicit free tier (`-free` / `:free` model, which OpenCode's own catalog prices at zero), and a custom-source response served by a local runtime (Ollama, LM Studio, llama.cpp, MLX). A coding-plan or subscription zero is not one of these; it is still estimated at API rates. Missing optional cache-read rates currently fall back to 10% of input; reasoning uses output rates unless a dedicated rate exists. Cache writes made with the 1-hour TTL (Claude Code reports the split per response) are billed at the registry's `cacheWrite1hPerMillion` when present, else at 2× input when the model id contains `claude` — Anthropic's published 1h rule — and at the ordinary write rate otherwise. Anthropic models logged without `claude` in the id (for example `fable-5-1`) therefore currently get the ordinary write rate for their 1-hour writes, which understates those writes. These are estimation rules, not provider billing guarantees. Long-context tiers, service tiers, negotiated discounts, and other fees are not fully modeled by the current calculator.

Tokmeter uses kosha's catalog and optional `~/.tokmeter/pricing-overrides.json` overrides. A gateway's rate can be used when a usable origin rate is absent. This is another reason to read the result as an estimate.

**The same model is priced at the rate of whoever served it (since 1.18.0).** OpenCode, Kilo and Kilo CLI route one model through many providers and write the provider beside the model, and the rate differs a lot by route: DeepSeek V4.1 Flash is $0.15/$0.60 per million on Ollama Cloud, $0.30/$1.19 on Alibaba and $0.016/$0.89 on OpenRouter. Their model ids now carry the route, as `model@provider`, so breakdowns keep the routes apart and a response the tool didn't price is billed at that provider's own catalog rate; failing that, at the model's rate as before. Costs the tool reported itself are unchanged. An override can name the route (`"deepseek-v4.1-flash@ollama-cloud"`). Which upstream OpenRouter picked for a call isn't written anywhere on disk, so OpenRouter routes are priced at OpenRouter's list rate.

Today exposes cost provenance in `/api/statbar-signals`: the estimated and reported amounts, unavailable count, and per-model breakdown. Model/project cost totals may combine different bases. Existing historical rollups do not contain enough provenance for a reliable retrospective split, so normal refreshes retain their original values.

## History and corrections

Completed days are stored in the local relay. Normal refreshes update today's usage and read saved history. Only today is repriced when the price catalog updates; since 1.15.0, editing `~/.tokmeter/pricing-overrides.json` also reprices today. Completed days keep the cost they were sealed with. A deliberate rescan can rebuild a bounded historical window; retention guards protect against replacing a day with incomplete input. Back up a day before applying a reviewed correction.

**Each day keeps the prices it was billed at (since 1.17.0).** The price catalog keeps no history: it is overwritten on every refresh. So a rescan used to bill a past day at the rates of the day the rescan ran, and a day could change cost without one token changing. Each sealed day now stores the rates every model was billed with, and a rescan bills that day with them. A day sealed before 1.17.0 has no stored rates; a rescan derives them from what the day cost, scaling today's rates so the day's own tokens cost exactly what was sealed. Those derived rates are marked "implied". A model the day had no rate for (new in the rescan, or unpriced back then) is billed at today's rate. Costs a tool reported itself are never repriced.

**A deleted or archived thread stays in the day it ran in (since 1.17.1).** Today is recounted from the session files on disk every few seconds, so deleting a thread before midnight used to take its usage out of the day, and that smaller day was what got sealed. Tokmeter now keeps the last usage of any file, or database thread, that disappears today and counts it until the day seals, including across a restart and when the daemon was off at midnight (it reads what it kept, in `~/.cache/tokmeter/today/`). Moving a file, as a Codex archive does, isn't counted twice. Usage already lost before 1.17.1 can't be recovered this way. Since 1.18.0, a file rewritten smaller in place (a transcript pruned by hand) also keeps what it lost, for tools whose responses carry the provider's own id (Claude Code, Codex, Kimi, Copilot CLI, Muse); tools that number responses by position or not at all (Cline, Roo, Kilo, Gemini, Qwen) are still taken as they are, because a renumbered response would look like a lost one. A rebuild or Deep Rescan of the past week folds the kept usage in too.

**Zed and Mux count each day's growth (since 1.17.1).** Both report a running total per thread. Tokmeter used to count the whole total on the day the thread was last used, so reusing a long thread added its history again. It now counts only what the thread added that day. A thread it sees for the first time counts from then on, unless it was created that day.

**A day that may be missing usage is flagged (since 1.17.0).** A day can only hold what the parsers read. After a day seals, the daemon looks through each tool's whole data folder for session files that changed that day, contain a real token count, and fed nothing into the ledger, and warns if it finds any. This is how a tool changing where it writes (Codex moving finished sessions to `~/.codex/archived_sessions` in October 2026) shows up the next morning instead of weeks later. It does not recount tokens. Run it for any day with `tokmeter coverage --date YYYY-MM-DD`.

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

**A sealed day keeps its prices.** A rebuild bills a day with the rates stored
on it, never today's. A day's cost changes only when its tokens do.

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
