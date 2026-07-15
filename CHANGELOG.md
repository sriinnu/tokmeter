# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.2] - 2026-07-15

### Fixed

- **Deep Rescan can no longer shrink sealed history.** The windowed rebuild
  used to overwrite sealed relay days unconditionally; when the raw JSONL
  behind a day had aged out (or a file read truncated mid-stream), the rebuilt
  day was smaller and the loss was permanent — this shrank a sealed
  2026-06-12 on 2026-07-12, and by 2026-07-15 four more days (2.4B tokens)
  would have gone the same way. Sealed days are now only replaced when the
  rebuild carries at least as much data, per provider (`shouldKeepSealedDay`);
  `/api/rescan?force=true` remains the explicit override for parser-fix
  rescans where shrinking is the point.
- Per-file fail-soft read errors in the codex and claude-code parsers (and
  the shared `readJsonlFile`/`readJsonlFileFromOffset` helpers) now surface
  as provider warnings tagged `partial` instead of silently truncating a
  scan. Partial faults deliberately do NOT abort the trailing gap-fill (one
  permanently unreadable file must not block sealing forever); a forced deep
  rescan refuses to shrink a sealed day for a provider that hit a truncated
  read during that rebuild.
- The sealed-day guard also protects frozen cost: a rebuild that re-derives
  identical tokens but lower cost (kosha unreadable/offline during the
  rescan, a model since pruned from the registry) keeps the sealed day.
- Provider warnings no longer accumulate without bound in the warm daemon:
  each refresh tick and each deep rescan replaces the previous cycle's
  provider warnings instead of appending duplicates forever.
- Summary cache schema bumped to 3 so cached summaries holding the old
  even-split model rows rebuild instead of being served post-upgrade.
- The trailing gap-fill no longer seals days BEFORE the gap from the partial
  slice a fresh-mtime multi-day file happens to carry — interior holes stay
  open for an explicit rescan instead of freezing a partial day forever.
- Model summaries now use the exact per-project (provider, model) cross-cut
  instead of even-splitting a day-level bucket across providers — one model
  used by codex and codex-desktop in the same day no longer shows two
  identical phantom rows with fractional half-tokens.
- The web dashboard's "Today" is now actually today: the last daily entry is
  only presented as today when its date matches the local calendar date,
  instead of relabeling the most recent active day.
- `ensure-summary` no longer bakes an arbitrarily stale cached summary into
  the static web build: it prefers the live daemon, accepts the cache only if
  it was scanned today, and rescans otherwise.

### Added

- **Today, hour by hour** panel on the web dashboard: today's cost per local
  hour as a 24-bar chart with a custom hover tooltip (cost, tokens, records,
  busiest model per hour), current-hour marker, and an honest whole-series
  switch to token bars when the day has no priced usage.

## [1.9.1] - 2026-07-10

### Added

- Nothing new; this is a correctness patch release.

### Changed

- Normalized Codex usage provenance so output totals are explicitly treated as a derived bucket when reasoning tokens are present.
- Cleaned up Codex Desktop parser/test formatting so the release lint gate stays green.

### Fixed

- Fixed Codex CLI aggregate totals for newer models that report `reasoning_output_tokens` inside `output_tokens`, preventing reasoning tokens from being counted twice.

## [1.9.0] - 2026-07-10

### Added

- **VS Code Copilot Chat tracking.** Reads VS Code's own chat session store
  for model + request timestamps. Copilot bills via a quota'd "premium
  request" model, not tokens, so there's no local $/token figure to
  report - those stay honestly blank rather than guessed at.
- **Antigravity tracking.** Google's Antigravity IDE keeps its agent history
  in an undocumented protobuf blob with no public schema. Decoded it by
  hand (varint + length-delimited wire format, a one-field wrapper around
  base64 text) to recover session timestamps and the project each session
  touched. No model, token, or cost data exists anywhere in its local
  state - not a gap in this parser, a gap in what the app exposes.
- **Zed tracking.** Zed is open source, so this one's built straight from
  its real schema (`crates/agent/src/db.rs`) instead of reverse-engineered
  - real token counts and model name, read from its local SQLite thread
  store.
- **Local Cursor tracking, no external sync required.** Cursor's usage was
  previously only visible via a CSV cache populated by a separate
  "tokscale" sync tool. Added a second source that reads Cursor's own
  local SQLite store (`cursorDiskKV`) directly - real per-message tokens
  and model name, zero setup. The CSV path still wins when it has data, so
  nobody who's already syncing gets double-counted.

### Fixed

- **Roo Code and Kilo were dead on macOS and Windows.** Both parsers only
  ever checked the Linux VS Code path (`~/.config/Code/...`), so they
  silently returned zero records on every Mac despite being listed as
  supported providers.
- **kilo-cli and OpenCode's SQLite reads were dead under Bun.** They used
  `better-sqlite3`, whose native bindings Bun refuses to load - this
  project's own CLI/daemon runtime. All SQLite-backed parsers now pick
  `bun:sqlite` under Bun and fall back to `better-sqlite3` under Node.

## [1.8.0] - 2026-07-09

### Fixed

- **Codex mtime-masquerade melt.** Editing or blanking old Codex rollouts bumps
  their filesystem mtime, so a today/recent scan's mtime prefilter matched
  hundreds of months-old files and re-parsed gigabytes through an unbounded
  fan-out - pinning the daemon in V8 GC (148% CPU, indefinitely) so it stopped
  answering the bar ("STALE"/offline). Fix: mtime is now only a cheap prefilter
  that can *over*-keep but never drop; the real drop authority is each file's
  actual newest **event** timestamp, read from a 64 KB tail before any full
  parse. The fork-dedup fan-out is concurrency-capped so a scan always completes
  instead of thrashing. A long-running session whose rollout lives under an old
  date directory but is still active today is no longer silently dropped.

### Changed

- **The scan invariant: today + relay, nothing else.** A normal scan now reads
  only today's live files plus the sealed per-day relay aggregates. The 14-day
  raw re-scan is gone from the default path - it re-derived already-sealed days
  and, on a large corpus, blocked the daemon ~90 s on every cold boot. Cold boot
  is now ~250 ms.
- **Pace baseline moved into the relay.** The "typical spend by this time of
  day" signal reads a new per-day intraday cost curve (`costByHour`, 24 slots)
  sealed with each day's aggregate, instead of re-parsing raw history. Days
  sealed before the field existed are skipped (never counted as `$0`); pace
  fills in as new days seal, or via a Deep Rescan.
- Record-consuming MCP tools (`search`, `heatmap`, `export`, `anomaly`) and
  `alias suggest` now request their multi-day window explicitly, since the
  default scan no longer seeds a 14-day record set.

### Added

- **Deep Rescan** (Hub → Data, confirm-gated): the one explicit path that
  re-reads raw history. It is **windowed** - re-derives and overwrites only the
  last 30 sealed days (backfilling `costByHour` and correcting any recently
  mis-sealed day), leaving older history untouched. Streamed file-by-file (large
  rollouts read line-by-line, one at a time), memory-guarded (refuses below
  ~6 GB free), and fire-and-forget. The main panel's Refresh stays a quick,
  today-only read - reads are reflexes, writes are deliberate.

## [1.7.1] - 2026-07-03

### Added

- Test coverage for the daemon's HTTP security boundary: WS origin allowlist,
  HTTP Host-header DNS-rebinding guard, bearer-token comparison, and today/
  lifetime floor monotonicity (`server.test.ts`, 19 cases).
- Field-level contract checks between the daemon's TS response shapes
  (`TokmeterStats`/`DailyEntry`/`ModelSummary`) and the Swift Codable structs
  that decode them — a renamed/removed field now fails CI instead of silently
  breaking the bar's decode path at runtime.

### Fixed

- The `.block` menubar color source (5-hour billing-block tint) never
  actually worked: it read a statusline cache file that nothing wrote, always
  silently falling back to neutral. It now rides the live daemon `/api/quick`
  endpoint, same round-trip and same clear-on-offline behavior as the context
  source.
- Relay dedup fingerprinting omitted `project` — two different projects
  hitting the same provider/model at the exact same millisecond with
  identical tokens/cost could silently collapse into one record. Fixed and
  locked in with a regression test.

## [1.7.0] - 2026-07-02

### Added

- Live menubar health color: the bar tints green→yellow→orange→red from a live
  signal (worst session across providers), switchable between context-window
  fill, the 5-hour billing block, and cost-vs-budget. Universal-first — cost
  works for every provider; context-fill lights up where the agent exposes it.
  A dedicated ~5s poll keeps the tint live regardless of the full-refresh
  cadence. The percentage stays visible so color is never the only signal.

### Changed

- `bundle.sh` installs to /Applications in every mode and hard-fails a
  signed/release build when `SUPUBLIC_KEY` is empty, whitespace-only, or not a
  valid Ed25519 key — closing the un-updateable-build hole.

### Fixed

- Relay accuracy: cold-scan rebuild now shares the live fold's validity gate
  and per-day fingerprint dedup, so a month-of-dormancy gap-fill is
  byte-identical to live (no over-count); late records at a midnight rollover
  are folded into the sealed day instead of lost; a day present in both the
  sealed map and the live accumulator is counted once (backward-clock guard);
  an unreadable provider dir is surfaced rather than sealed as a lower number.
- Prototype-pollution / crash hardening in aggregation for hostile
  `__proto__`/`constructor` model/project/provider names (null-proto maps).
- Security: statusline local-RCE via a world-writable `/tmp` cache closed
  (private cache dir + integer coercion); daemon WebSocket origin allowlist and
  HTTP Host allowlist (DNS-rebinding); backup-path containment.

## [1.6.1] - 2026-06-05

### Fixed

- **macOS bar Hub no longer crashes at large/maximized window sizes.** The Hub
  could die with an uncaught AppKit exception ("more Update Constraints passes
  than there are views in the window") on tab navigation or an idle data refresh
  whenever the window was maximized. Root cause was `NavigationSplitView`'s
  internal Auto-Layout machinery re-entering the window's constraint pass at large
  sizes without converging; replaced it with a plain HStack sidebar+detail layout.

### Changed

- Hardened the Hub's layout against constraint-pass re-entrancy: `cascadeIn`
  entrances are a single in-transaction write, the loader's 30s poll applies its
  updates in a non-animating transaction, KPI/pulse tile rows use a deterministic
  grid, and frame dimensions are guarded against non-finite values.

## [1.6.0] - 2026-05-30

Durability + survivability hardening for the relay and daemon, plus launchd
supervision so the daemon self-heals across crash, OOM, and login. The relay's
"no data loss" promise now holds across a hard power loss, not just a clean
exit. Also splits the core library to MPL-2.0 and redesigns the macOS Hub
sidebar.

### Added

- **@sriinnu/drishti** — launchd supervision: `tokmeter daemon install-agent`
  / `uninstall-agent` install a `com.tokmeter.daemon` LaunchAgent with
  conditional `KeepAlive{SuccessfulExit:false}` — the daemon respawns on a
  crash, OOM-kill, or login, but a clean exit (EADDRINUSE bow-out, normal
  shutdown) stays down instead of storming. `resolveLaunchTarget` prefers a
  `node + dist` entry over `bun + source` so the `NODE_OPTIONS` heap cap is
  actually enforced (bun ignores it). Install aborts on a held port, is
  transactional (unlinks the plist on bootstrap failure), and `start`/`stop`/
  `restart` dispatch on whether the agent is actually loaded.
- **macOS bar** — Hub sidebar redesign: brand lockup, live connection status,
  ambient "Today" card, grouped navigation with ⌘-number shortcuts.

### Changed

- **@sriinnu/tokmeter-core** — license changed from AGPL-3.0-only to
  **MPL-2.0** so the parsing/pricing/relay engine can be embedded in any
  project; the application surfaces stay AGPL-3.0-only.
- **README** — de-marketed, honest memory/RSS band, relay-store and
  daemon-lifecycle architecture sections, corrected signal/test/store counts.

### Fixed

- **@sriinnu/tokmeter-core** — `writeDayFile` now fsyncs the data and the
  directory around the rename and uses a per-process tmp suffix: a sealed day
  survives a hard power loss, and concurrent sealers can't tear each other's
  temp file. Daemon `saveState` made atomic the same way.
- **@sriinnu/tokmeter-core** — `DailyAccumulator.fold()` drops malformed
  records (NaN/Infinity/negative numerics, empty model id) so a single bad
  JSONL line can't poison the day's totals or the cache-math identity.
- **@sriinnu/drishti** — the daemon survives a recoverable throw: an unhandled
  promise rejection logs and continues instead of exiting; an uncaught
  exception exits cleanly for a launchd respawn rather than dying silently.

## [1.5.0] - 2026-05-24

The "no more lifetime records" release — Phase 3.3 of the aggregate cutover.
The daemon's history layer moves from a single 187 MB monolithic snapshot to
a directory of per-day immutable aggregate files. The lifetime
`TokenRecord[]` is structurally eliminated from `TokmeterCore`; cold start
scales with the gap between disk-newest and yesterday (typically 0–1 days),
not lifetime corpus size.

### Changed — per-day relay store (the "relay race" architecture)

- **@sriinnu/tokmeter-core** — On-disk history layout switched from
  `~/.cache/tokmeter/history-snapshot.json` (monolith, ~187 MB on a 77 GB
  corpus) to `~/.cache/tokmeter/aggregates/YYYY-MM-DD.json` (one immutable
  file per completed day, ~6 KB each, ~848 KB total). Files are write-once;
  midnight rollover seals today's accumulator into the next day-file
  without touching anything older. Rsync-friendly, language-agnostic,
  `cat day.json | jq`-inspectable.
- **@sriinnu/tokmeter-core** — `TokmeterCore.scan()` no longer materialises
  a lifetime `TokenRecord[]`. The default daemon path now: load per-day
  aggregates → bounded 14-day mtime-watermarked recent scan → today scan
  → fold today into the live accumulator. Explicit-range queries
  (`since`/`until`/`--year`/...) do an ad-hoc bounded raw scan against just
  the requested window.
- **@sriinnu/tokmeter-core** — One-shot v2 → relay migration runs once on
  first cold start, splatters the legacy monolith into per-day files, and
  renames the legacy file to `.legacy` so future starts read the relay
  only. Idempotent — safe to call when per-day files already exist.
- **@sriinnu/tokmeter-core** — `tokmeter-core.ts` refactored from 1017 LOC
  into a 392-line state holder + 5 focused modules:
  `scan-pipeline.ts` (parser fan-out, windowed scans),
  `relay-loader.ts` (per-day store + v2 migration),
  `pricing-enrichment.ts` (enrichCosts, opaque-model gate),
  `kosha-wishlist.ts` (atomic wishlist writer),
  `cross-tool.ts` (today × top-models projection).

### Performance (verified on a 77 GB / 292k-record / 147-day corpus)

- History store on disk: 187 MB → 848 KB (**220× smaller**).
- Lifetime records held in heap: gone (structurally; verifiable in source).
- Hot-path queries (cache hit, within 12 s TTL): ~1–6 ms per endpoint;
  `api/projects` (170 KB payload) ~2–4 ms.
- Today-scope refresh on TTL miss: ~5 s for the 77 GB Codex corpus
  (unchanged — that's parser I/O, not the relay).
- Daemon RSS: noisy due to V8 arena retention and the parser-level scan
  cache, but the floor dropped — idle RSS observed as low as ~30 MB
  (post-GC), versus the pre-v1.5 ~1.08 GB warm steady-state.

### Notes

- 170 tests pass, including 27 aggregate-migration parity assertions
  comparing legacy records-walking against the new aggregate-state path.
- Branch `feat/aggregate-cutover`: commits `cf75d33`..`0c582dc`.
- See `README.md` → Performance section for benchmark commands you can run
  locally.

## [1.4.0] - 2026-05-23

The "no more kernel panics" release — one warm singleton daemon as the single
source of truth, every reader (CLI, statusline, bar) becomes a thin HTTP
client, full-corpus scans stop happening on the hot path. Plus the
history-immutability fixes ("the past never moves") and the macOS bar's cache
"wallet" + KPI-display correction.

### Added — performance & architecture (one daemon, many readers)

- **@sriinnu/tokmeter-core** — `TokmeterCore.refreshToday()` warm-path API:
  re-scans only today (stat-pruned via a new `modifiedSinceMs` parser hint) and
  splices into loaded records, leaving frozen history untouched. The foundation
  for a daemon that stays warm without re-reading history.
- **@sriinnu/tokmeter-core** — **mtime-pruned today scans.** A today-only scan
  passes parsers a `modifiedSinceMs` watermark; honoring parsers (Claude Code,
  Codex) stat-prune to files touched today before reading. Turns a today
  refresh from a full-corpus read (~2 GB on Codex) into ~30 MB.
- **@sriinnu/tokmeter-core** — `getStats(records?)` accepts an optional record
  set so the daemon can serve provider-filtered stats from its warm core.
- **@sriinnu/drishti** — Daemon stays warm: history scanned once at startup,
  then only today refreshes via `refreshToday()` on a 12 s TTL — no more full
  `core.scan()` on a 5 s loop. New `/api/today` endpoint computes today's
  totals from the warm core (statusline reads this instead of scanning). New
  `?providers=` query filter on `/api/stats`, `/api/daily`, `/api/models`.
- **@sriinnu/drishti** — **Robust cross-process singleton.** `startDaemon()`
  checks the PID file + `process.kill(pid, 0)` and bows out cleanly if a live
  daemon already owns the port; `EADDRINUSE` on bind exits 0 instead of
  crash-looping. Bounded memory via `DAEMON_HEAP_CAP_MB` (default 6144 — high
  enough for the cold warm scan, low enough to bound a runaway).
- **@sriinnu/drishti** — Statusline reads `GET /api/today` instead of running
  its own `core.scan({today:true})`; 4 s watchdog + guaranteed `process.exit`
  + fire-and-forget daemon autostart on miss. Statusline subprocesses are now
  ~70 MB / sub-second (was ~2 GB ballooning to kernel panic).
- **@sriinnu/tokmeter-cli** — `--json` read commands (`stats`, `daily`,
  `models`, `projects`) read the warm daemon over HTTP when reachable
  (`ready` OR `warming` — never falls back to a local scan while the daemon
  is up). Each call ≈ 100 MB / 0.16 s versus the prior ~2 GB. External
  pollers calling `tokmeter stats --json --codex` on a loop become cheap.
- **TokmeterBar** — Auto-starts the singleton daemon when offline and reads
  the daemon only; removed the per-fetch `tokmeter --json` CLI-scan fallback
  that was the immediate kernel-panic trigger.

### Fixed — history immutability ("the past never moves")

- **@sriinnu/tokmeter-core** — Frozen history is no longer re-priced on a scan.
  Cost enrichment now runs over **today's** records only; historical records
  keep the cost frozen when first priced (a legitimate `$0` stays `$0` after a
  `kosha update`). Re-pricing `$0` history at today's rates on every scan was a
  silent immutability leak.
- **@sriinnu/tokmeter-core** — **Append-only history rollover.** On a calendar
  rollover the frozen snapshot is extended with the newly-frozen gap days
  instead of being discarded and re-derived from disk (`historySource:
  "extended"`). The old rebuild re-priced all history at today's rates and lost
  tokens whenever a provider scan hiccuped — the "tokens/cost keep depleting"
  bug. The append is monotonic by construction and can never shrink history.
- **@sriinnu/tokmeter-core** — **Monotonic floor guard.** A full rebuild that
  comes back materially smaller than the frozen snapshot (a provider parser
  threw, a scan was interrupted) is refused; the healthy snapshot is kept. A
  transient failure can no longer permanently shrink frozen history.
- **@sriinnu/tokmeter-core** — Append-boundary record-loss fix:
  `readJsonlFileFromOffset` checks the real newline boundary (byte before the
  offset) instead of sniffing the first character, so a complete record at the
  seam is never dropped.
- **TokmeterBar** — KPI cards (TOKENS / SPENT) no longer make a frozen lifetime
  total *look* like it's depleting. The delta pill and sparkline use settled
  days only (today's partial day excluded), so a half-day mid-day no longer
  reads as "↓93%".
- **TokmeterBar** — Cache "wallet" slide-out drawer (CACHE & CONTEXT moved out
  of the main scroll into an on-demand panel opened from a hero-header icon),
  with the FRESH/MISS/WRITE buckets fixed to a non-duplicated HIT/MISS/WRITE
  partition plus a derived FRESH roll-up.

See [docs/architecture.md](docs/architecture.md) for the full data-freshness,
immutability, and singleton-daemon model.

## [1.3.0] - 2026-05-16

The biggest release since 1.2.0 — honest accounting (Tier 1), animated chrome
(Tier 2), route projection (Tier 3), two new themes, a major refactor pass,
and a license upgrade.

### License

- **MIT → AGPL-3.0-only.** Single copyright holder, clean flip. AGPL's
  section 13 (network-use clause) applies if anyone runs a modified tokmeter
  as a network service — `drishti` is the MCP/HTTP daemon that touches that
  surface. LICENSE replaced; six npm packages updated to SPDX
  `AGPL-3.0-only`; README badge + footer flipped.

### Added — Tier 1 (correctness + parity)

- **@sriinnu/tokmeter-core** — `reasoningToday` signal: reasoningTokens /
  outputTokens today, clamped at 1.0 (some Codex variants over-report).
- **@sriinnu/tokmeter-core** — Claude Pro/Max 5-hour billing window detector.
  Bounded 2× lookback so the gap-walker can verify candidate `blockStart`
  actually opened a fresh block (smaller lookbacks clipped previous blocks'
  tail records into phantom windows).
- **@sriinnu/tokmeter-core** — **Subagent attribution.** Parser depth bumped
  3→5 to pick up `<slug>/<sessionId>/subagents/agent-*.jsonl`. Records tagged
  `isSubagent: true`. Was silently missing from totals before.
- **@sriinnu/tokmeter-core** — Opaque-models filter (`codex-auto-review` etc.)
  so provider-side alias labels don't pollute the unpriced-wishlist.
- **TokmeterBar** — Hub "Today's pulse" card: 5 mini-tiles (burn / cache /
  compaction / reasoning / subagents) + a wide Claude 5h billing strip with
  progress bar. Inactive tiles render dimmed with "—" (was dishonest "0%").
- **TokmeterBar** — Pricing anomaly pill collapses per-field rows by model
  (one provider price change typically fans out across input/output/cacheRead).

### Added — Tier 2 (visual + engineering signal)

- **TokmeterBar** — Burn-rate flame chip animation. SF Symbols
  `.variableColor.iterative.reversing` with intensity scaled by $/hr.
- **@sriinnu/tokmeter-core** — Tool-call cost breakdown. Claude Code parser
  extracts `tool_use` block names; aggregator computes per-tool cost share
  today. Surfaced as the Hub "Today's tools" card.
- **TokmeterBar** — 365-day GitHub-style activity heatmap in the Hub.
  Geometry-driven cells, log-scale color clipped at 95th percentile, cached
  grid via @State.
- **TokmeterBar** — Click-through anomaly drill-in sheet. Footer pill becomes
  tappable; sheet rises with anticipation-squash, group cards cascade in.
- **TokmeterBar** — Composition-gradient cost bar. Each model row's bar
  encodes BOTH cost share (length) AND tier composition (color): ≥50%
  dominant → solid, else hard-stop gradient of top 2 tiers. Cost numeral
  tinted by dominant tier; provider glyph prefix (sparkle / hex / g.circle).

### Added — Tier 3 (innovation)

- **@sriinnu/drishti / TokmeterBar** — Cross-tool projection. New
  `/api/cross-tool` endpoint projects today's exact token shape against the
  user's top 6 lifetime models. Hub "If today ran on…" card surfaces it with
  Δ-vs-actual.
- **@sriinnu/tokmeter (CLI)** — `tokmeter routes`. MVP of the cost-surface
  explorer (see `docs/designs/routes.md`). Layer 1 pricing translation — table
  or `--json`. Honest exclusion of unpriced models.

### Added — Themes (curated to 7)

- **Aurora** — Northern-lights drifting gradient. Motion as identity — first
  theme where the background itself is alive.
- **Noise** — Neobrutalist canary yellow. Cards: solid white + 2pt black
  border + 3pt hard offset shadow.
- **Hidden** (cases stay in enum for persisted-settings safety, but not in
  the picker): Daylight, Synthwave, HUD, Mint, Blueprint.

### Changed — performance

- `signals.ts` pace loop bounded by 2× `PACE_BASELINE_DAYS` — at 100k records
  this cut per-scan cost from ~5-15ms to ~0.5ms.
- `todayRecords` filter switched to numeric epoch-ms bounds.
- Billing-window detection: O(n log n) sort → O(n) walk + bounded lookback.
- Heatmap grid cached via @State, rebuilt only on day rollover.

### Changed — code organization (LOC budget enforced ≤400)

- `HubOverview.swift` 1312 → 196 (14 focused sibling files extracted).
- `HubProjectDetail.swift` 706 → 262.
- `HubSettings.swift` 687 → 367.
- `TokmeterLoader.swift` 527 → 299 (CLI fallback in extension).
- `HubCommands.swift` 492 → 295 (catalog extracted).
- `HeroBackground.swift` 488 → 227 (hidden-theme renderers extracted).
- `Theme.swift` 463 → 269 (modes + ThemeFonts extracted).
- Extracted `Color.tokDanger / .tokWarning / .tokSuccess` to Theme.swift
  (was 9 duplicated RGB triples across 5 files).

### Fixed

- **Billing window phantom-block bug.** 5h lookback was clipping previous
  blocks' tail records into a "fresh" block — UI claimed up to 4h54m left on
  already-expired windows.
- **Hero hardcoded white text** on light themes (Noise). Switch defaulted to
  white, baking it into the canary-yellow surface.
- **Provider glyph for namespaced models** (`openrouter/anthropic/...`) now
  strips the `openrouter/` prefix before pattern-matching.

### Tests

- 78 → 124 core tests. Regression coverage for phantom-block, unsorted-array
  records, reasoning share clamp, parallel-tool cost split, subagent share,
  today-blocks-only count.

## [1.2.1] - 2026-05-13

### Changed

- **@sriinnu/tokmeter-core**, **@sriinnu/tokmeter** — bumped `@sriinnu/kosha-discovery` pin from `^1.0.0` to `^1.2.0`. No code changes; picks up kosha 1.2.0's expanded provider coverage and registry refinements on next install.
- **All packages** — version bumped 1.2.0 → 1.2.1.
- **TokmeterBar** — `bundle.sh` defaults bumped 1.2.0/14 → 1.2.1/15 to keep the bar in lockstep with the npm release. No new notarized zip / appcast entry in this release — bar binary is unchanged.

### Docs

- **README** — staleness pass after #30's workspace-private lockdown: broken install commands fixed, MCP tool count corrected to 24, stale "static pricing table" claim removed, missing CLI commands (`update`, `pricing-audit`, `install-cron`/`uninstall-cron`/`cron-status`) added, test count refreshed.
- **README** — new "What it looks like" section with three screenshots (macOS bar popover, weekly digest, project breakdown). Real data, real numbers, names sanitized for privacy.
- **docs/designs/routes.md** — design for `tokmeter routes`, a provider-agnostic cost surface explorer that reprices session/branch/project token volume across every (model × serving-provider) tuple in kosha. Design only — no implementation yet.

## [1.2.0] - 2026-05-12

### Added

- **@sriinnu/tokmeter-core** — `StatbarSignals` type + `computeStatbarSignals(records, now)`. Five "right now" signals derived in one pass: burn rate (last 60 min $/hr), cache hit % today, pace vs. typical-cost-by-this-hour (median over last 7 active days), compaction tax today, and a live-session pointer when a record exists in the last 5 min. Tested across 7 deterministic scenarios.
- **@sriinnu/tokmeter-core** — Claude Code parser tags the assistant record preceding a `system.subtype:"compact_boundary"` event as `kind:"compaction"`. Canonical signal — no heuristics. Surfaced via the new `TokenRecord.kind` field (optional, defaults to `"normal"`).
- **@sriinnu/drishti** — new `GET /api/statbar-signals` endpoint.
- **TokmeterBar** — `SignalsRibbon` view below the hero: burn / cache / compaction chips, color-ramped by intensity, self-hides when no live signal.
- **TokmeterBar** — `PACE` card replaces the old `STREAK` vanity card when ≥2 days of pace history exist (tortoise / hare / equal icon, color-coded; falls back to streak on first use).
- **TokmeterBar** — live-session pill replaces the generic ECG when something's run in the last 5 min (`project · age` with pulsing green dot, tooltip carries model + last-record cost).
- **docs/backup-restore.md** — dedicated walkthrough for `cleanup` / `snapshot` / `restore` extracted from the README.

### Changed

- **@sriinnu/tokmeter-core** — scan-cache version bumped 5 → 6. Old caches are re-parsed on first run so the `kind` field is honest from the start; one-time hit, no user action.
- **README** — macOS Menu Bar surface now has a dedicated section; architecture diagram includes all five consumers; CHANGELOG-style cleanup pass.

## [0.5.1] - 2026-04-29

###

### Fixed

- **@sriinnu/tokmeter-core** — historical reprice bug where `tokmeter update` silently rewrote past spend at current kosha rates ($21K of historical cost became $15K when prices dropped). `clearRecordCache()` was wiping per-record frozen costs; the snapshot rebuild path then re-priced historical JSONL records via `enrichCosts`. Removed the cache-clear from the update path — `koshaMtime` tracking already resets cost=0 on today's records only, so historical stays frozen via the cost > 0 skip in `enrichCosts`.
- **@sriinnu/tokmeter-core** — same freeze leak in `CleanupService.restore`: `clearRecordCache()` removed; history-snapshot + summary invalidation alone are sufficient.
- **TokmeterBar** — when daemon was offline, the footer "Pricing: Xh ago" badge and Settings cron row never updated. Loader now reads `~/.kosha/registry.json` mtime + plist presence directly from disk on the CLI fallback path.

### Added

- **@sriinnu/tokmeter-cli** — `install-cron` / `uninstall-cron` / `cron-status` commands. Daily `tokmeter update` at 00:05 local time via macOS launchd (auto-fires on next wake if asleep at midnight).
- **TokmeterBar** — pricing freshness badge in footer ("Pricing: 2h ago") with TimelineView 60s tick.
- **TokmeterBar** — Settings (popover + Hub) shows fetched age, Force-refresh button when >24h stale, daily-cron install state with last-run success/failure and Install/Disable buttons.
- **@sriinnu/drishti** — `GET /api/pricing-status` (kosha registry mtime), `GET /api/cron-status` (plist installed, last run, success/failure tail).
- **@sriinnu/tokmeter-core** — `tokmeter-core.test.ts` and `cleanup-service.test.ts` skeletons that lock the freeze invariant.

### Changed

- **@sriinnu/tokmeter-cli** — `tokmeter update` is now lightweight: kosha pull only, no scan, no cache wipe.
- **@sriinnu/tokmeter-cli** — cron install resolves a stable absolute binary path (`which tokmeter` → `process.argv` → pinned-version `npx`); kills `@latest` supply-chain risk and PATH-hijack on `/opt/homebrew`.
- **@sriinnu/tokmeter-cli** — daily-cron log truncated each run; success/failure substring scan is unambiguous and the log stays bounded. Plist uses `rm -f LOG` before truncation so a hostile symlink can't redirect the truncate at an arbitrary file.
- **@sriinnu/tokmeter-cli** — `launchctl bootstrap` invoked via `execFileSync` with fixed argv (no shell formatting); plist paths XML-escaped.
- **@sriinnu/drishti** — `/api/cron-status` reads only the last 8KB of the cron log, opens with `O_NOFOLLOW` to refuse symlinks (defense against local file disclosure), `fstatSync` on the open fd to close the TOCTOU window. `process.env.HOME` → `os.homedir()`.

## [0.5.0] - 2026-04-28

### Added

- **TokmeterBar** — macOS Hub window (NavigationSplitView): Overview, Projects drilldown, Commands catalog, Settings panel.
- **TokmeterBar** — Today's Models tab in models section.
- **TokmeterBar** — pricing refresh button in Settings (calls `/api/update-pricing`).
- **@sriinnu/tokmeter-web** — Today's Models tab on the dashboard.
- **@sriinnu/drishti** — `GET /api/today-models`, `GET /api/update-pricing` endpoints.
- **@sriinnu/tokmeter-cli** — `tokmeter update` command for on-demand kosha refresh.
- **@sriinnu/tokmeter-core** — user-config pricing overrides (negotiated rates, free internal deployments).
- **@sriinnu/tokmeter-core** — project alias system, snapshot/restore with cross-home remap, lazy auto-refresh of pricing.

### Changed

- **@sriinnu/tokmeter-core** — kosha is the single source of truth for pricing; static fallback table removed.
- **TokmeterBar** — live timer refresh cadence driven by `HubConfigStore` via Combine.
- **bundle.sh** — auto-detect tokmeter notarization key (separate from any sibling project's key under the same Apple Developer account); bumped to 0.5.0/build 6.

### Fixed

- `/api/today-models` was leaking all-time data into the today tab — core dist hadn't been rebuilt after adding the today filter to `getModelCosts`.
- `bundle.sh` nested `.p8` path resolved for tokmeter notarization key.

## [0.4.0] - 2026-04-23

### Added

- **TokmeterBar** — signed + notarized macOS menu bar release pipeline via `bun run bar:ship` (clean → notarized build → GitHub release upload)
- **TokmeterBar** — `bar:publish` script for uploading an already-built zip to a GitHub release
- **bundle.sh** — `{VERSION}` placeholder substitution in `RELEASE_DOWNLOAD_URL` with fail-fast validation, eliminating version drift between `.env` and appcast enclosure
- Cross-project Apple release playbook at `~/Sriinnu/Personal/domain-knowledge/apple-releases/` (Sparkle keys, App Store Connect API, notarization agreement-403 dance, TestFlight gotchas)

### Changed

- **All packages** bumped to `0.4.0` for a clean npm baseline before the macOS bar overhaul
- **@sriinnu/tokmeter-cli**, **@sriinnu/tokmeter-core**, **@sriinnu/tokmeter-tui** — `private: true` removed so they publish to npm alongside `@sriinnu/tokmeter`, `@sriinnu/drishti`, `@sriinnu/tokmeter-web`
- **Docs scope corrected** — all READMEs, SKILL.md files, CHANGELOG, and `docs/wip.md` now reference the real npm scope `@sriinnu/*` instead of the non-existent `@tokmeter/*`
- **bundle.sh** default version bumped from `0.1.0`/`1` → `0.4.0`/`4` so an unversioned build no longer ships as 0.1.0

### Fixed

- `appcast.xml` XML comment containing `--release` (XML 1.0 forbids `--` in comments) caused Python strict parsers to reject the feed
- `bar:release` exit code was being masked by `| tee` — pipeline now uses `> log 2>&1` so real failures surface
- `drishti` MCP server self-reported version (was hardcoded to `0.1.0`, now `0.4.0`)

## [0.1.0] - 2026-04-01

### Added

- **@sriinnu/tokmeter-core** — Token tracking engine with 16 provider parsers (Claude Code, Codex, Cursor, OpenCode, Gemini, Amp, Droid, Kilo, Kilo CLI, Kimi, Mux, OpenClaw, Pi, Qwen, Roo Code, Synthetic)
- **@sriinnu/tokmeter-core** — 4-tier pricing via @sriinnu/kosha-discovery (20+ providers with static, kosha direct, kosha fuzzy tiers)
- **@sriinnu/tokmeter-core** — Aggregation utilities for model costs, daily breakdown, and statistics
- **@sriinnu/tokmeter-cli** — CLI with table, JSON, and pricing lookup modes
- **@sriinnu/tokmeter-tui** — Interactive TUI with bar charts, sparklines, and heatmaps
- **@sriinnu/tokmeter-web** — React + Plotly web dashboard with multiple views (Dashboard, Models, Projects, Timeline, 3D)
- **@sriinnu/drishti** — MCP server exposing 16 tools for token usage analysis
- **@sriinnu/drishti** — Statusline hook for Claude Code with TrueColor support, project/branch display, and per-model breakdown
- **@sriinnu/drishti** — Live TUI dashboard for real-time token monitoring
- README.md and SKILL.md documentation for all packages
- MIT license
- TypeScript strict mode with declaration files (.d.ts)
- ESM with proper exports map
- Monorepo workspace setup with Bun
