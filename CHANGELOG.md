# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
