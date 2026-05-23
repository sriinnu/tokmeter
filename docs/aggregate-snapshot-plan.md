# Aggregate-Snapshot Cutover — Implementation Plan

> Status: groundwork shipped (`packages/core/src/aggregates.ts` + 12 tests).
> Next step is the irreversible cutover. This doc is the spec for that.

## Goal

Drop tokmeter daemon RSS from ~1.5 GB → ~100 MB without changing any displayed
numbers. We do this by replacing the per-record warm set with **per-day
aggregates + today's raw records**. Aggregates are ~few MB total; today is a
few thousand records. V8 GC pauses become invisible, Ghostty stays smooth, the
whole "scan the corpus for lifetime stats" question becomes "sum aggregates."

## What's shipped (Slice 1)

- `packages/core/src/aggregates.ts` — `DailyAggregate`, `aggregateRecordsByDay()`,
  `sumAggregates()`, `longestConsecutiveDayStreak()`. Pure functions, no
  state, no side effects. JSON-round-trips losslessly (no `Map` / `Set`
  leaks).
- `packages/core/src/aggregates.test.ts` — 12 tests covering single-day,
  multi-day, sorting, firstUsed/lastUsed, multi-provider model overlap,
  sumAggregates, streak, JSON round-trip.

These are pure additions — they can't break anything that exists today.

## Slice 2 — Snapshot v3 dual-format reader (foundational)

**File:** `packages/core/src/history-snapshot.ts`

- Bump `HISTORY_SNAPSHOT_VERSION` from 2 to 3. Keep v2 read support for
  one-shot migration.
- Define `HistorySnapshotV3File`:
  ```ts
  { version: 3, stableThrough, createdAt, updatedAt, days: DailyAggregate[] }
  ```
- Extend `LoadedHistorySnapshot` shape:
  ```ts
  { aggregates: DailyAggregate[], records: TokenRecord[] | null, ... }
  ```
- `loadHistorySnapshot`:
  - v3 → `aggregates` populated from `days`, `records = null`.
  - v2 → `records` populated from file, `aggregates = aggregateRecordsByDay(records)` derived.
  - unknown / unreadable → `historySource: "none"`, both empty.
- `saveHistorySnapshot`: still writes v2 for now. **Don't change the writer
  until Slice 3 reader has shipped and is verified.**

Add tests:
- v3 file → returns aggregates, records null.
- v2 file → returns records AND derived aggregates.
- v2 → v3 migration: aggregate-derived totals == sum-of-records totals.

## Slice 3 — TokmeterCore cutover (the bandage)

**Files:** `tokmeter-core.ts`, `signals.ts`, `history-snapshot.ts`, daemon
endpoints, possibly `aggregator.ts`.

### State change
```ts
// before
class TokmeterCore { private records: TokenRecord[] = []; }
// after
class TokmeterCore {
  private aggregates: DailyAggregate[] = []; // frozen historical
  private todayRecords: TokenRecord[] = [];   // today's raw, mutable
}
```

### scan()
- `resolveFrozenHistory()` → returns `DailyAggregate[]` (from snapshot, with
  v2→v3 migration on first load).
- `scanTodayRecords()` → returns `TokenRecord[]` (today only, unchanged).
- Set `this.aggregates = frozen`, `this.todayRecords = today`. Remove
  `this.records = [...]` site.
- After first successful v3-aware scan, write v3 snapshot. Optionally keep v2
  alongside as a backup for one release cycle then delete.

### refreshToday()
- Becomes trivial: re-scan today (mtime-pruned), replace `this.todayRecords`.
  No filter, no splice, no kosha-change handling against history (history is
  aggregates, no records to reprice). Today is freshly priced anyway.

### Consumer rewires

| Method | Before | After |
|---|---|---|
| `getStats(opts?: {providers?})` | sum over `this.records` | `sumAggregates(filterAggregates(this.aggregates, opts))` + sum-over-`todayRecords` filtered by opts |
| `getDailyBreakdown(opts?)` | aggregateByDate over records | aggregates as `DailyEntry[]` + today's daily entry |
| `getModelCosts(opts?)` | aggregateByModel(records) | merge per-day `models` buckets across aggregates + today's per-model |
| `getAllProjects()` | aggregateByProject(records, aliases) | merge per-day `projects` buckets + today's per-project, then resolve aliases |
| `getProjectSummary(name)` | filter records, aggregateByProject | filter per-day `projects[name]` buckets + today |
| `getProviderBreakdown()` | aggregateByProvider(records) | merge per-day `providers` buckets + today's per-provider |
| `getCrossToolComparison()` | aggregateByModel(records).slice(0,6) + today filter | merge aggregates' top-6 models + today's token shape |
| `getStatbarSignals(now)` | computeStatbarSignals(records, now) | computeStatbarSignals(todayRecords, aggregates, now) — pace uses aggregates' daily totals, all other signals are today-only |
| `getRecords()` | returns this.records | **semantic break: returns todayRecords only.** Add `getDailyAggregates(): DailyAggregate[]` for callers that need historical data. |
| `getSummary()` | returns { records: this.records, ... } | returns { aggregates, todayRecords, ... } — wire shape change, web/TUI need update if they consume `summary.records` |

### Daemon endpoint updates

- `/api/stats?providers=codex` and friends: stop doing
  `filterByProvider(core.getRecords(), providers)`. Pass providers to the
  core method directly: `core.getStats({providers})`.
- `/api/today` floor stays.
- `computeTodayTotals(core)` simplifies to summing `core.getRecords()` (which
  now returns today only — no filter needed).
- `/api/summary` shape change: deal with the wire contract (web/TUI consumers).

### Snapshot writer cutover

- `saveHistorySnapshot(homeDir, stableThrough, aggregates)` — new signature.
- On the first successful warm cycle with the new code, write v3 file. Old v2
  file kept as `history-snapshot.json.v2.bak` for one release cycle. Document
  the rollback path: `mv ~/.cache/tokmeter/history-snapshot.json.v2.bak
  ~/.cache/tokmeter/history-snapshot.json && tokmeter daemon stop && start`.

### Floor guard
- `sumSnapshotTokens(records)` → add `sumAggregateTokens(days: DailyAggregate[])`
  (just sum `day.totalTokens`).
- `shouldKeepExistingHistory` is already format-agnostic (takes numbers).

## Verification (Slice 3 acceptance)

1. Cold start the daemon on the real corpus. Measure RSS.
   - Target: **<150 MB warm.** (Was ~1.5 GB.)
2. Run a ground-truth raw-records scan and a daemon scan side-by-side.
   - Lifetime cost, today cost, codex-filtered cost, daily breakdown, top
     models, all projects → **must match to the cent and to the record count.**
3. /api/today still monotonic (today-floor stays).
4. CLI fast-path still works (chitragupta's bridge calls
   `tokmeter stats --json --codex` → daemon read → ~100 MB / 0.16 s).
5. macOS bar shows correct numbers after reinstall.

## Migration safety net

- Keep v2 snapshot file as a `.v2.bak` for one release.
- Add a `TOKMETER_FORCE_LEGACY_SNAPSHOT=1` env var that opts back into the
  v2 raw-records path during the transition. Daemon honors it on cold start.
  Remove after one release.

## Out of scope for this cutover

- Streaming JSONL parsing (P0 #2 in the ranked list) — keep as a follow-up.
  Less urgent once today's parse is the only hot path.
- Hash-based record dedup for codex (P2 #6) — keep the floor on /api/today as
  the user-facing guard. Real dedup is a deeper change.
- SQLite cache (P3 #3) — the aggregate snapshot already reduces the JSON-load
  hit by ~30×. SQLite becomes optional.

## When to do this

Fresh focused session. Not at the tail of a long debug chat. The wins are
large (1.5 GB → 100 MB) but the surface is wide enough that subtle wrong-
number bugs are the failure mode. Take the time to do it once, correctly.
