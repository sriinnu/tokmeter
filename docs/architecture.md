# Architecture — Data Freshness, Immutability & the Daemon Model

> Last updated: 2026-05-22

This document describes how tokmeter stores history, keeps "today" live, and
serves data to its consumers (CLI, TUI, web, macOS bar, statusline, MCP)
**without re-reading the whole session corpus on every read**. It is the
reference for the freshness/immutability/memory model — the part of the system
that, when it went wrong, re-priced frozen history and exhausted RAM.

---

## 1. Two stores, two jobs

Tokmeter never trusts a single in-memory pass. It composes two on-disk stores:

| Store | File | Holds | Job |
|---|---|---|---|
| **Record cache** | `~/.cache/tokmeter/scan-cache.json` | parsed `TokenRecord[]` per source file, keyed by `(path, mtime, size)` | avoid re-parsing unchanged session files |
| **History snapshot** | `~/.cache/tokmeter/history-snapshot.json` | every record **through yesterday**, frozen | serve stable history without re-deriving it |

The record cache is a *parse-speed* optimization. The history snapshot is the
*immutability anchor* — it is what guarantees yesterday's numbers don't move.

The two stores have **independent version numbers**. A record-cache schema bump
(`CACHE_VERSION`) does **not** invalidate the frozen snapshot, so a parser
change can never silently re-price the past.

---

## 2. Immutability: the past is frozen, only today is live

The invariant, stated plainly: **anything already recorded is history and is
never overwritten.** Yesterday's tokens, cost, and usage are settled. Only
*today* — still in flight — re-prices when kosha pricing changes.

How the code enforces it:

- **History is never re-priced on a normal scan.** `scan()` runs cost
  enrichment over *today's* records only. Historical records keep whatever cost
  was frozen when they were first priced — including a legitimate `$0` (model
  wasn't in kosha that day stays `$0` forever). The only way a frozen cost ever
  changes is an explicit `rescanHistory`.
- **Append-only rollover.** When the calendar rolls, the snapshot is **not**
  discarded and rebuilt from disk. `resolveFrozenHistory()` keeps the existing
  snapshot's records as an immutable base and freezes only the *gap* days that
  rolled from "today" into the past on top (`historySource: "extended"`). Base
  cost is never recomputed, so a record-cache version bump can't rewrite frozen
  days. The append is monotonic by construction — base + gap ≥ base — so it can
  never shrink history.
- **Monotonic floor guard.** A full rebuild (first run, explicit rescan, schema
  bump) that comes back materially smaller than the existing snapshot — e.g. a
  provider parser threw and returned `[]`, or a scan was interrupted — is
  *refused*. The healthy snapshot is kept instead of being clobbered. A
  transient failure must never permanently shrink frozen history.
- **Append-boundary safety.** Incremental ("append-only") parsing of a grown
  JSONL file decides where the previous read ended by checking the actual
  newline boundary (the byte before the offset), not by sniffing the first
  character — so a complete record at the seam is never silently dropped.

> Historical context: the "tokens/cost keep depleting" bug was a violation of
> this model — the old rollover re-derived all history from disk (re-pricing it
> at today's rates and losing tokens on any partial scan), and a separate path
> re-priced `$0` history on every scan. Both are fixed; see the CHANGELOG.

---

## 3. Cheap reads: today-scans don't touch the whole corpus

A statusline tick or a daemon refresh only needs *today*. There is no reason to
read months of `rollout-*.jsonl`.

- **mtime-pruned today scans.** A today-only scan hands parsers a
  `modifiedSinceMs` watermark (local midnight). Parsers that honor it
  stat-prune their file list to files touched today before reading anything.
  Because records are *appended* (which advances a file's mtime), a file
  containing today's records always has an mtime today — so this can't drop a
  today record. For Codex (which keeps no record cache and would otherwise
  cold-re-parse everything) this is the difference between a ~2 GB read and a
  ~30 MB one.
- **`TokmeterCore.refreshToday()`** — the warm-path API. Re-scans only today
  (mtime-pruned), splices the result into the loaded records, and leaves frozen
  history untouched. Falls back to a single full `scan()` when the core is cold.
  This is what lets a long-lived process stay warm and update every few seconds
  without ever re-reading history.

---

## 4. Single source of truth: one daemon, many readers

**Design intent (the target):** one **singleton daemon** holds the data warm in
memory and is the single source of truth. Every consumer — the macOS bar, the
statusline, MCP tools — is a thin **reader** of the daemon over its local HTTP
API. Nothing else scans the corpus on its own.

Why: scanning is expensive and memory-heavy. If each of N sessions × each
refresh tick spawns its own scan, the machine drowns in concurrent multi-GB
processes (this is what was causing macOS kernel panics). One warm daemon
reading once and serving many is bounded and fast.

### Status

| Piece | State |
|---|---|
| Core `refreshToday()` + mtime-pruned today scans | ✅ landed |
| macOS bar reads the daemon only; auto-starts the singleton daemon when offline; no per-fetch CLI-scan fallback | ✅ landed |
| Daemon stays warm and refreshes only today via `refreshToday()` (instead of a full `core.scan()` on a short TTL) | 🚧 in progress |
| Statusline reads the daemon's `/api/today` instead of running its own `core.scan({today:true})` | 🚧 in progress |
| Daemon hard singleton (cross-process PID guard, `EADDRINUSE` handling) + process rails (guaranteed exit, bounded heap on spawn) | 🚧 in progress |

### Rules for readers

- **Never** call `core.scan()` on a hot path (statusline tick, bar poll).
- If the daemon is down, **start it once** (it enforces its own PID singleton)
  and show last-known / skeleton state until it's warm — do **not** fall back to
  spawning scan subprocesses.
- Treat the daemon's numbers as authoritative; the persisted summary cache
  (`saveSummaryCache`) is the offline fallback, not a reason to re-scan.

---

## 5. Memory model — why it stays bounded

- **History is read once** (snapshot) and frozen; it is not re-derived per read.
- **Today is small** and refreshed via the mtime-pruned warm path.
- **One daemon** holds the warm set; readers are HTTP clients that allocate
  almost nothing.
- One-shot CLI commands (`stats`, `daily`) that genuinely need full history are
  user-invoked and occasional — not on any loop — and are the only place a
  larger transient is expected.

The failure mode this design exists to prevent: a hot path (statusline, bar
poll) triggering a full-corpus scan in a fresh process, multiplied across
sessions and ticks, stacking faster than the processes exit. The fix is
architectural — make the hot paths *readers*, keep one warm *writer*.
