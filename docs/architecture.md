# Architecture - Data Freshness, Immutability & the Daemon Model

> Last updated: 2026-07-09 (1.8.0)

This document describes how tokmeter stores history, keeps "today" live, and
serves data to its consumers (CLI, TUI, web, macOS bar, statusline, MCP)
**without re-reading the whole session corpus on every read**. It is the
reference for the freshness / immutability / memory model - the part of the
system that, when it went wrong, re-priced frozen history and exhausted RAM.

The one-line mental model, which the rest of this doc expands:

> **A scan reads today's live files (raw) + the sealed relay (aggregates).
> Nothing else. Past days are never re-parsed except by an explicit rescan.**

---

## 1. The stores

Tokmeter never trusts a single in-memory pass. It composes on-disk stores under
`~/.cache/tokmeter/`:

| Store | Path | Holds | Job |
|---|---|---|---|
| **Relay** | `aggregates/YYYY-MM-DD.json` | one sealed, immutable per-day rollup (totals + per-model/project/provider buckets + a 24-slot intraday `costByHour` curve) | the history source of truth; months of history in a few MB |
| **Record cache** | `scan-cache.json` | parsed `TokenRecord[]` per source file, keyed by `(path, mtime, size)` | skip re-parsing unchanged session files (used by Claude Code's append-offset reads; Codex streams and does not cache) |
| **Summary cache** | `summary-cache.json` | the last computed summary payload | offline fallback for readers when the daemon is down - **not** a reason to re-scan |

The relay is the immutability anchor: a completed day is a small frozen file, so
yesterday's numbers cannot move under a normal scan. Today lives only in memory
(a `DailyAccumulator`) until midnight seals it into the relay.

> Historical note: before v1.5.0 the anchor was a single ~200 MB
> `history-snapshot.json` monolith (now retired to `.legacy`; a one-time
> migration splits it into per-day relay files). The monolith was re-derived on
> rollover - which re-priced history at today's rates and lost tokens on any
> partial scan (the "tokens keep depleting" bug). The relay's per-day sealing
> makes that class of bug structurally impossible.

---

## 2. Immutability: the past is frozen, only today is live

The invariant, stated plainly: **anything already sealed is history and is never
overwritten.** Yesterday's tokens, cost, and usage are settled. Only *today* -
still in flight - re-prices when kosha pricing changes.

How the code enforces it:

- **History is never re-priced on a normal scan.** `scan()` runs cost enrichment
  over *today's* records only. A sealed day keeps whatever cost was frozen when
  it sealed - including a legitimate `$0` (a model absent from kosha that day
  stays `$0` forever).
- **Seal on rollover.** When the daemon runs across midnight,
  `refreshTodayAccumulator` freezes the outgoing day into the relay (deduping
  any late "straggler" records via fingerprint), so the day survives even if its
  raw JSONL is later deleted.
- **Gap-fill, bounded.** On cold start `refreshFromRelay` loads the sealed days
  and, if the newest on-disk day is older than yesterday, fills only the
  *trailing gap* from raw - it never re-parses interior days (a day the user
  simply didn't use is indistinguishable from a hole and must not trigger a
  full-corpus scan).
- **The only exception is an explicit rescan** (`rescanHistory` / the Hub's Deep
  Rescan). That is the sole path allowed to re-derive and overwrite sealed days.

---

## 3. The scan invariant: today + relay, nothing else

A statusline tick or a daemon refresh only needs *today* plus the already-sealed
past. There is no reason to re-read months of `rollout-*.jsonl`.

A normal `scan()` does exactly two things:

1. **`refreshFromRelay()`** - load the sealed per-day aggregates (cheap; small
   JSON files). This is all past days.
2. **`scanTodayRecords()`** - parse only today's live files into the today
   accumulator.

That's it. There is **no 14-day raw re-scan** on the hot path (it existed
before 1.8.0, re-derived already-sealed days, and blocked the daemon ~90 s on
every cold boot; cold boot is now ~250 ms).

**Today's raw scan is mtime-immune.** Parsers get a `modifiedSinceMs` watermark
(local midnight). mtime is used *only* as a cheap prefilter that can **over**-keep
 - it never drops a file, because an appended event advances mtime, so any file
with a real today-record has a today mtime. The actual drop authority is each
file's **newest event timestamp**, read from a 64 KB tail before any full parse.

> Why the event-time authority matters (the melt this fixed): editing or blanking
> an old Codex rollout bumps its mtime to "now". Under an mtime-only filter,
> hundreds of months-old files then masquerade as "today" and get fully re-parsed
> - gigabytes, pinning the daemon in GC (148% CPU) so the bar goes STALE.
> Event-time as the drop authority makes the file's real data date the truth;
> path/filename date is **not** used (a long-running session's rollout keeps its
> start-day directory but is still active today - dropping it by path would
> silently zero the user's biggest active session). The fork-dedup fan-out is
> concurrency-capped so a scan always completes instead of thrashing.

**`refreshToday()`** is the warm-path API: re-scan only today, splice onto the
in-memory recent window, leave the relay untouched. `recentRecords` accumulates
forward (today's records, carried across ticks) - it is never re-seeded from a
raw history scan. It exists only to feed the live signals; the bar's totals and
7-day chart come from the relay.

---

## 4. Pace reads the relay, not raw history

The "pace vs. typical" signal needs *typical spend by this time of day* over the
last few days. Rather than re-parse raw history for it, each sealed day carries a
**`costByHour`** curve (24 local-hour slots) written when the day seals - the
same value on the live-fold and cold-rebuild paths (guarded byte-for-byte by the
relay-accuracy tests). Pace sums each recent day's curve up to the current hour
and takes the median. Days sealed before `costByHour` existed are skipped (never
counted as `$0`, which would drag the baseline down); pace fills in as new days
seal, or via a Deep Rescan backfill.

This is the general rule: **anything a signal needs about a past day must live in
the relay**, because past days are never re-read on a normal scan.

---

## 5. Deep Rescan: the one explicit raw re-read

Deep Rescan (Hub → Data, confirm-gated) is the single path that re-reads raw
history. It is deliberately constrained:

- **Windowed.** It re-derives and overwrites only the last 30 sealed days
  (`rebuildRecentWindow`) - enough to backfill pace's curve and correct any
  recently mis-sealed day. Older days (which pace never reads) are left as-is.
  A full rebuild from scratch exists only for a first-ever cold start or an
  empty/corrupt relay.
- **Streamed.** Both rebuild paths share `foldRawIntoDays`, which walks providers
  and folds each file's records into per-day accumulators, then releases them -
  peak memory is one file, not the corpus. For Codex, large rollouts (≥ 8 MB) are
  streamed line-by-line and parsed one at a time; smaller files batch
  concurrently. A single unreadable file fails soft (skips that file only).
- **Guarded.** The `/api/rescan` endpoint refuses when free memory is low
  (~6 GB), is POST + token-gated (CSRF/DoS), and is fire-and-forget (returns
  immediately, rebuilds in the background) so an HTTP client can't time out.

The split it encodes: **reads are reflexes, writes are deliberate.** The main
panel's Refresh is a quick today-only read; Deep Rescan - which rewrites sealed
days - lives in the Hub behind a confirm.

---

## 6. Single source of truth: one daemon, many readers

One **singleton daemon** holds the data warm in memory and is the single source
of truth. Every consumer - the macOS bar, the statusline, MCP tools - is a thin
**reader** of the daemon over its local HTTP API. Nothing else scans the corpus
on its own.

Why: scanning is expensive and memory-heavy. If each of N sessions × each refresh
tick spawns its own scan, the machine drowns in concurrent multi-GB processes
(this is what caused macOS memory-pressure reboots). One warm daemon reading once
and serving many is bounded and fast.

### Rules for readers

- **Never** call `core.scan()` on a hot path (statusline tick, bar poll). Read the
  daemon's HTTP endpoints (`/api/quick`, `/api/today`, `/api/summary`).
- If the daemon is down, **start it once** (it enforces its own PID singleton) and
  show last-known / skeleton state until it's warm - do **not** fall back to
  spawning scan subprocesses.
- Record-consuming MCP tools that genuinely need a multi-day record set request it
  explicitly (an explicit date range), since the default scan is today-only.

---

## 7. Memory model - why it stays bounded

- **The past is a stack of small sealed files** (the relay), read into compact
  per-day aggregates - not re-derived per read.
- **Today is small** and refreshed via the mtime-immune warm path.
- **One daemon** holds the warm set; readers are HTTP clients that allocate almost
  nothing.
- **The one heavy path - Deep Rescan - is windowed, streamed, and memory-guarded**
  (and the daemon child runs with a bounded V8 heap). It cannot load the whole
  corpus at once, and it refuses to start when RAM is tight.

The failure modes this design exists to prevent, all observed in the wild:

1. A hot path (statusline, bar poll) triggering a full-corpus scan in a fresh
   process, multiplied across sessions and ticks - the original kernel-panic
   cause. Fix: hot paths are *readers*, one warm *writer*.
2. mtime-masquerade re-parsing gigabytes of old files as "today" - the STALE-bar
   melt. Fix: event-time drop authority + concurrency cap (§3).
3. A full-history rescan holding the whole corpus in memory, stacked on other
   memory hogs, OOM-rebooting the box. Fix: windowed + streamed + guarded rescan
   (§5).
