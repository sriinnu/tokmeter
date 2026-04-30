# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2026-04-30

First major release. Aligned with `@sriinnu/kosha-discovery@1.0.0`. The
defense stack underneath today's pricing/usage data is now considered
production-grade:

### Layers (paired with kosha-discovery 1.0.0)

| # | Layer | Owner |
|---|---|---|
| 1 | kosha runtime model lookup | kosha |
| 2 | tokmeter manifest fallback (mtime+size cache, schemaVersion guard, provider-shadow tie-break, two-sided pricing predicate) | tokmeter |
| 3 | unpriced-records detection signal (capped, override-aware) | tokmeter |
| 4 | VDOM-style merge — preserves dropped entries on partial failure | kosha |
| 5 | Pricing-aware merge — degraded-fresh keeps old usable rates | kosha |
| 6 | Atomic write (tmp + rename) | kosha |
| 7 | O_EXCL cross-process file lock | kosha |
| 8 | Schema-version guard | kosha + tokmeter |
| 9 | Hermeticity test guard | both |
| 10 | Smart-merge — seed pricing onto API stubs | kosha |
| 11 | Pricing-diff anomaly log + 7-day snapshot rollback ring | kosha |

### Added (TokmeterBar)
- **Daily kosha-refresh cron** (macOS launchd) — `tokmeter install-cron` /
  `uninstall-cron` / `cron-status`. Runs `tokmeter update` at 00:05 local;
  auto-fires on next wake if asleep.
- **Pricing-freshness footer badge** — "Pricing: 2h ago" (TimelineView 60s tick).
- **Daily-cron status row in Settings** (popover + Hub) with last run / success
  state and Install/Disable button.
- **Anomaly footer pill** — "⚠ N price changes" when kosha logged
  >25% rate movement in last 24h. Catches the failure mode every other
  defense makes WORSE (wrong number, not null).
- **Hub Settings parity** — pricing + cron rows mirrored from popover.
- **macOS Hub window** — Overview, Projects drilldown, Commands, Settings
  (NavigationSplitView; ⌘1–⌘5 sections).

### Added (CLI / daemon)
- **`tokmeter pricing-audit --json`** — exports today's verification:
  `{today, resolved, unpriced, anomalies, pricing, meta}`. Exit 0 healthy /
  exit 2 needs attention. Pipeable into CI gates.
- **Kosha-wishlist writer** — at each scan, writes
  `~/.tokmeter/wishlist.json` with unpriced models + today-hit-counts so
  kosha can bias provider priority.
- **GET `/api/health`** — surfaces silent $0 leaks (capped at 100 with
  `truncated` flag).
- **GET `/api/anomalies`** — last 24h of kosha-detected pricing anomalies.
- **GET `/api/pricing-status`** + **GET `/api/cron-status`**.
- **GET `/api/today-models`** + **GET `/api/update-pricing`**.

### Changed
- **kosha-discovery dep bumped from `^0.6.0` to `^1.0.0`**.
- **Two-sided pricing predicate** in 6 lookup sites: replaces
  `originPricing ?? pricing` (which short-circuited on a zero origin stub
  and silently zeroed proxy-only routes).
- **macOS bar now treats user-overridden $0 models** as intentionally free
  (no false-positive amber pill).
- **`tokmeter update`** is lightweight — kosha pull only, no scan, no
  cache wipe. Removed `clearRecordCache()` which was the root cause of
  the historical reprice bug ($21K → $15K).
- **CleanupService.restore** matches: no cache wipe; history-snapshot +
  summary invalidation only.

### Fixed
- Historical reprice leak in `tokmeter update` (the $21K → $15K bug).
- Same leak path in `CleanupService.restore`.
- Daemon-offline state: footer badge + cron row stayed stale forever
  because `loadFromCLI()` short-circuited before phase 2.
- `/api/cron-status` log read now uses `O_NOFOLLOW` to refuse symlink
  exfiltration via local processes.
- Plist log truncation uses `rm -f LOG; : > LOG` so a hostile symlink
  can't redirect the truncate at an arbitrary file.
- Test isolation: `~/.kosha` and `~/.tokmeter` snapshotted before each
  suite; tests that touch them fail loudly.

## [0.5.1] - 2026-04-29

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
- **bundle.sh** — auto-detect tokmeter notarization key (separate from Runics key); bumped to 0.5.0/build 6.

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
