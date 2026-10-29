# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),\
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The macOS release workflow is split by privilege. An unprivileged job
  (read-only token, no environment, no secrets) runs everything that executes
  third-party code (`bun install`, vite and its plugins, `swift build`) and
  uploads the unsigned app with its sha256. Only then does the `release`
  environment job import the Developer ID certificate: it checks that sha256
  and the app's identity, version and build number against the verified tag,
  signs with the hardened runtime (new `sign-app.sh`, shared with local
  builds), notarizes, staples, and Sparkle-signs using its own `sign_update`
  pinned by `Package.resolved`. A last job with write access but no signing
  secrets and no repository code uploads the zip and opens the appcast PR.
- TokmeterBar now enables Sparkle's `SUVerifyUpdateBeforeExtraction` and
  `SURequireSignedFeed` (Sparkle 2.10.0): updates are EdDSA-verified before
  extraction, and the appcast itself is signed with the release key in CI and
  verified against the app's own key before publishing. Builds with this
  setting reject an unsigned or hand-edited `appcast.xml`.
- The menubar's pricing refresh and cron install/uninstall run
  `@sriinnu/tokmeter` pinned to the app's own version, like the daemon
  bootstrap already did, instead of whatever `npx` resolved as latest.
- `scripts/release.sh` verifies the appcast PR before merging it: opened by
  github-actions[bot] from this repository into `main`, changing only
  `packages/macos-bar/appcast.xml`. It shows the diff and pins the merge to
  the head commit it checked.
- Restoring a backup no longer writes into Claude Code's `session-env`
  directory, whose hook scripts Claude Code runs; those entries are skipped and
  listed, and the rest of the archive still restores. OpenClaw restores are
  limited to its per-agent `sessions` folders, so config and credential files
  in its config directories can't be overwritten from a snapshot.
- A restored `config.json` keeps this machine's Antigravity live-polling
  choice, and restored aliases can no longer hide projects that are visible
  here.
- Cleanup only derives a Claude Code session's side folders from a real
  session id, and refuses (deleting nothing) any target that is the home
  folder, `~/.claude`, `~/.claude/projects` or a session root, or contains
  one. Roo Code and Kilo cleanup deletes only a task folder directly inside
  its tasks folder, never the tasks folder itself.
- Cleanup never deletes a shared app database (such as Cursor's
  `state.vscdb`) as a whole file; the preview lists it as not removable and
  leaves it in place.
- The daemon refuses to start, without writing an auth token, when another
  process holds its HTTP API port, so clients can't send their token to it.
  It exits non-zero after a pause so launchd retries about once a minute.
- The statusline cache moved out of the shared temp folder into a private
  per-user directory (`$XDG_RUNTIME_DIR`, else `~/.cache/tokmeter/statusline`)
  with owner-only, symlink-safe writes. Its repo commands no longer run a
  repository's fsmonitor hook or take optional locks, and branch names are
  stripped of terminal controls.
- The Antigravity live poller only looks at your own processes, runs `ps` and
  `lsof` by absolute path, caps the response size, and sanitizes model labels
  and reset times.
- Label sanitizing runs in linear time; crafted labels could previously stall
  output for seconds.
- A project named `__proto__` is no longer dropped from the daemon's
  per-project totals, and file paths in `tokmeter coverage` output and TUI
  warnings are stripped of terminal controls.

### Fixed

- **One inconsistent sealed day no longer breaks every report.** Claude Code
  wrote `ephemeral_1h_input_tokens: 2050` beside `cache_creation_input_tokens:
  0`, so the sealed 2026-09-16 bucket held a 1h cache-write share (1,802,192)
  larger than its total (1,800,142). Since 1.19.3 the relay reader rejected
  that day and with it the whole history: `tokmeter daily --since …` exited 1
  and the daemon could not start. The parser now clamps the 1h share, the
  writer refuses an invalid day, and the reader repairs that sub-bucket in
  memory (no total or cost moves; the file is never rewritten) and quarantines
  a truly unreadable day with a warning instead of failing the load.
- **The midnight seal no longer drops the last minutes of the day.** The
  first tick after midnight only read files modified since midnight, so a
  response written after the previous tick, in a file not touched again, was
  never sealed. With the bar polling every 300 s that lost Codex records on 6
  of 7 nights (e.g. 4 records, 36,240 input / 348,288 cache-read tokens on
  2026-10-28). The rollover tick now reads back to the previous tick.
- **Codex guardian reviews are no longer double-counted.** A guardian_review
  thread that continues in a new rollout opens with a counter holding the
  previous rollout's totals; it was booked as new usage. 28 phantom records
  across 2026-10-22…10-29, e.g. 1.07M input and 7.3M cache-read tokens on
  2026-10-24 (more where Codex later rewrote the rollout). The carried-over
  counter is now taken as the baseline.
- **Large session files keep counting.** Claude Code sessions are streamed
  line by line from the cached offset, so a session past 128 MiB is no longer
  refused (a rebuild of 2026-10-21 lost 955 records, 205M cache-read tokens).
  An oversized line (a 16 MB tool output) is skipped instead of truncating
  the rest of the file (107 Codex responses on 2026-10-22); the usage of an
  oversized Claude assistant line is recovered from its head and tail.
- **A partial read only holds the days it can affect.** A fault in a file
  that cannot hold the outgoing day no longer stalls the midnight seal (which
  froze "today" on yesterday), and a rebuild persists every day the faulting
  file cannot touch instead of none — a fresh install on a corpus with one
  bad file now gets its history.
- **Fork subagents no longer double-bill their parent's turn.** A fork's
  transcript opens with a copy of the parent's last message (same message id);
  Claude Code records are now one per message id across all files (47 copies,
  14.4M cache-read tokens since 2026-09-26).
- **Date filters use local days.** A date-only `since`/`until` was parsed as
  UTC midnight (in CET it dropped 00:00–01:00 of the first day and took
  00:00–01:00 of the day after), and `week` was a rolling 168 h. This also
  corrects the date window cleanup uses to select session files.
- **Sealed days keep their price cards again.** Every rollover seal since
  2026-10-21 was written without cards: kosha rewrites its registry during the
  day, so at the midnight tick the cards had always "changed" and the seal
  gave up. It now seals with the cards the day was last priced at.

## [1.19.3] - 2026-10-25

### Security

- Closed the legacy daemon PID-file symlink overwrite, bounded JSONL and MCP
  inputs, and neutralized terminal control sequences in provider and alias
  labels. Large ledgers now stream to an exact file snapshot without record
  caps or append races, and compressed Codex rollouts have bounded inflation.
  Zod is pinned to patched 4.6.7 across the dependency graph.
- Destructive MCP cleanup and restore are now owner-disabled by default;
  cleanup additionally requires a short-lived, one-use receipt bound to the
  exact preview target set and collateral warnings, while its pre-delete
  backup remains mandatory. Backup metadata is size- and schema-validated.
- Release jobs now require the complete Apple/Sparkle signing chain, verify
  owner-authorized hardware-signed annotated tags from trusted `main` code,
  verify Sparkle before upload, separate unprivileged builds from OIDC publish,
  pin build tools and publisher checksums, and refuse package/tag drift.
- Removed unnecessary JIT and library-validation exceptions from the macOS
  app's hardened runtime and the unused sandboxed Sparkle launcher service.

### Documentation

- Synced the public Tokmeter site with the 1.19.2 wiki and clarified daemon
  token, dashboard session, restart, and restore guidance.

## [1.19.2] - 2026-10-23

### Security

- **Local usage reads now require the owner's daemon token.** The daemon's
  private HTTP routes and WebSocket upgrade, the browser dashboard, and its
  source development server no longer expose session and cost data to an
  anonymous process on the same machine. The menubar, CLI and statusline read
  the token from the owner's private daemon directory.
- **Tokmeter-owned settings, caches and backups use owner-only storage.**
  Existing files are tightened when used. Backup archives receive unique IDs
  and are validated and synced before cleanup can delete source files. Restore
  rejects unsafe parent symlinks and archives that exceed entry, expanded-size
  or available-space limits.

## [1.19.1] - 2026-10-23

### Security

- **Dependencies brought past every open advisory; `bun audit` is clean.**
  `@sriinnu/tokmeter-mcp` shipped `qs`, `body-parser`, `proxy-addr`,
  `ip-address` and `fast-uri` versions with known DoS, IP-spoofing and SSRF
  advisories, all under the MCP SDK's express stack. tokmeter serves MCP over
  stdio and the daemon binds localhost, so none was reachable, but they're
  now at fixed versions. The web dashboard moves from plotly 2 to 4, which
  drops the map engine with a critical XSS advisory from its bundle; its
  axis titles move to the `{ text }` form plotly 3 requires.

### Fixed

- **The web dashboard rendered a blank page.** It declared React 18 next to
  react-dom 19, and react-dom 19 reads internals React 18 doesn't have
  (`Cannot read properties of undefined (reading 'S')`). The dashboard now
  runs on React 19; the CLI and TUI stay on 18 for ink.

## [1.19.0] - 2026-10-22

### Added

- **Plan quota: `tokmeter quota` and `/api/quota`.** Codex writes its weekly
  window (used %, reset time, credit balance) into every rollout and tokmeter
  ignored it; Claude Code hands its 5-hour and 7-day windows to the statusline
  and writes them nowhere. Both are now kept under `~/.cache/tokmeter/quota/`,
  and each window shows its pace and whether that pace reaches 100% before the
  reset. Codex is read from the tails of its newest rollouts, never a rescan.
  A Codex window's reading is the highest seen, because parallel threads
  sometimes report a snapshot 1% behind.
- **Plan quota in the menubar bar.** A Plan quota section at the top of the
  popover shows each window's used %, when it resets, and, in amber, when the
  current pace hits 100% before the reset. A tick on each bar marks where an
  even pace would be by now, so a fill past it is spending faster than the
  window lasts.

## [1.18.0] - 2026-10-21

### Added

- **Kimi Code (the app and its CLI).** Its sessions live in `~/.kimi-code`, one
  `wire.jsonl` per agent, in a different format from the old Kimi CLI, so none
  of it was counted. Each LLM call is now one record, under the session's
  project, with subagents marked. K3 is priced from kosha as `kimi-k3`. Plan
  aliases such as `kimi-for-coding` don't say which model served them, so their
  tokens count but stay unpriced until kosha lists them. Days already sealed
  pick it up with `tokmeter backfill --kimi`.

### Changed

- **OpenCode, Kilo and Kilo CLI models now say who served them**, as
  `deepseek-v4.1-flash@ollama-cloud`. These tools route one model through many
  providers, and the price differs a lot by route: DeepSeek V4.1 Flash is
  $0.15/$0.60 per million on Ollama Cloud, $0.30/$1.19 on Alibaba and
  $0.016/$0.89 on OpenRouter. When a tool didn't report a cost, tokmeter used
  to price by model name alone and took whichever provider kosha matched first.
  It now uses the serving provider's own rate, then falls back to the name-only
  lookup. Costs the tool reported itself are unchanged. An override can name
  the exact route (`"deepseek-v4.1-flash@ollama-cloud"`). Which upstream
  OpenRouter picked isn't written anywhere on disk, so OpenRouter routes are
  priced at OpenRouter's list rate. Past days keep their model names.

### Fixed

- **`tokmeter --version` printed "latest" on Windows.** It looked for its own
  `package.json` from a URL path (`/D:/…`), which no file lookup finds. Found
  by the new Windows CI job, which builds tokmeter on Windows and runs the CLI
  and MCP on Node 20. Windows is still unsupported; that job shows what
  breaks first.

- **A transcript pruned by hand no longer takes its tokens out of today.** The
  grow-only today from 1.17.1 kept a deleted file's usage, but not a file
  rewritten smaller in place. Responses that vanish from a file that still
  exists are now kept too, for tools whose record ids are the provider's own
  (Claude Code, Codex, Kimi, Copilot CLI, Muse). Tools that number records by
  position or have no ids (Cline, Roo, Kilo, Gemini, Qwen) stay file-level:
  for them, a renumbered record would look like a lost one.
- **A full rebuild or Deep Rescan no longer drops usage deleted during the
  past week.** Re-deriving a day from raw used to ignore the today journal, so
  a thread deleted before its day sealed went missing from the rebuilt day.
- **Copilot CLI counted reasoning twice, and a session that ran past midnight
  could be lost.** Copilot reports output OpenAI-style, with reasoning inside
  it, and the parser added reasoning on top: on one machine that was 161K extra
  tokens over 12 days, each matching the reasoning in the rollup exactly. It
  also dated a whole session at its start, so a session that ended after
  midnight landed on a day that was already sealed. Each response's output now
  counts when it happens, and the shutdown adds the input and cache. A session
  that never shuts down still counts its output. Totals equal Copilot's own
  rollup. Already-sealed days keep their old numbers.
- **Just after midnight, today showed yesterday's whole total and stayed
  there.** The statusline and bar read today from the daemon without waiting
  for its refresh, so the first read after midnight still had yesterday's
  numbers, stamped with the new date. Today's high-water mark then held them
  all day. That's what happened on 10-21 ($290.85, 10-20's total) and on
  10-05 ($501.03, 10-04's). Display only: the sealed days were right. A read
  of yesterday's numbers now counts as nothing yet for the new day.

## [1.17.1] - 2026-10-20

### Added

- **Hover a model in the bar to see its full name.** Long ids were cut off
  ("deepseek-fla…", "minimax-m3.1…") with no way to read them. A small pill
  now shows the full id and its provider a moment after the pointer settles
  on the row, in every theme. It's drawn over the row rather than as a
  popover, which would take focus and close the menubar panel.

### Fixed

- **Deleting or archiving a thread no longer takes its tokens out of today.**
  Today was rebuilt from the session files present on each tick, so a
  thread deleted before midnight vanished from the day it ran in, and that
  smaller day was what got sealed (10-14 lost 64.3M Codex tokens this way).
  Tokmeter now keeps the last records of any file that disappears today and
  carries them until the day seals. Shared databases (OpenCode, Kilo CLI,
  Zed, Cursor) are carried per thread, so a session deleted inside one is
  kept too. It survives a daemon restart, a file deleted while the daemon
  was down, and the daemon being off at midnight (the next start seals the
  day with what was kept, from `~/.cache/tokmeter/today/`). A file that
  moved (a Codex archive) isn't counted twice.

- **Zed and Mux no longer count a thread's history again every day it's
  touched.** Both report a running total per thread, and tokmeter emitted the
  whole total stamped on the latest update, so reusing a long thread on a new
  day added its entire history to that day (and a fresh install put months of
  usage on one day). Tokmeter now keeps each thread's total as of the start of
  the day it's used and counts only the growth. A thread it sees for the
  first time counts from then on, unless it was created that same day, since
  there's no way to know how its history splits across past days. Days
  already sealed are unchanged.

- **A provider-filtered scan no longer shrinks the day.** A long-running
  process that ran one (e.g. a `--codex` view) replaced today with just that
  provider, and if midnight came next, the sealed day was missing the rest.

- **Codex subagent work now counts as subagent work.** The "Subagents" share
  in the bar and the signals left out every Codex subagent thread: the parser
  knew which rollouts were subagents (it groups them for dedup) but never
  marked their records. On a heavy multi-agent day that was most of Codex's
  usage (63.5% of one day's Codex tokens). Totals don't change; only the
  split does. Codex records also carry their response id now, the key later
  work uses to recognise the same response across scans.

## [1.17.0] - 2026-10-20

### Added

- **Tokmeter now tells you when a day may be missing usage.** After each day
  seals, the daemon walks every agent's folder (all of `~/.codex`, not just
  the `sessions` folder its parser reads) for session files that changed that
  day, carry a real token count, and fed no record, and says so in a warning:
  "2026-10-19 may be missing usage: 5 session files changed that day that no
  parser read (5 in ~/.codex/archived_sessions)". With 1.16.0's parsers it
  flags exactly the archived Codex rollouts behind the 10-18 hole; with
  today's it flags nothing. It re-parses nothing (the daemon already holds
  the day's records), skips databases, caches, logs and git checkouts, and
  takes about a second. `tokmeter coverage [--date YYYY-MM-DD]` runs it for
  any day without the daemon, and `/api/coverage` serves the last week's
  reports.

### Fixed

- **A Deep Rescan no longer reprices past days at today's rates.** kosha
  keeps no price history, so rebuilding a sealed day billed its records at
  whatever the rates were on the day of the rescan, and a day's cost could
  change without one token changing (a forced 30-day rescan moved 10-06
  from $458.54 to $453.44 and 10-12 from $143.53 to $136.95, tokens
  identical). Each sealed day now stores the price card every model was
  billed with (about 1–2 KB a day), and a rebuild bills the day with its own
  cards: those days keep $458.54 and $143.53. Days sealed before this get an
  "implied" card on rebuild, today's card scaled so the day's sealed token
  mix costs what was sealed. A backfilled provider is billed at the day's
  card for any model the day already priced. If kosha refreshes in the same
  tick as the midnight seal (a wake after midnight), the day seals without
  cards rather than with ones it wasn't priced at.

- **A long-running daemon kept pricing at stale rates.** It refreshes today
  every 12 seconds through a path that never refreshed kosha's price
  catalog; only a full scan (at startup) did. Without the macOS daily job
  installed, and always on Linux and Windows, rates froze at whatever they
  were when the daemon started. The daemon now refreshes the catalog once
  it's a day old, in the background, and after a failed refresh (offline)
  waits an hour before trying again instead of retrying every tick.

## [1.16.1] - 2026-10-20

### Changed

- **The statusline is redesigned around decisions.** Each segment answers
  something you'd act on: context fill (amber at 70%, red at 85%, "compacts
  next turn" from 95%, "compacting" at 100%, with turns left estimated from
  recent growth), the prompt-cache countdown with the rebuild size, session
  cost per hour of model working time (an 18h session with 58 active minutes
  reads $26.7/h, not $1.42/h), and the 5h/7d windows with a straight-line
  forecast to reset once 5% is used. The worst problem takes the second line
  in words: limit reached, limit coming before reset, context nearly full,
  router fell back, cache about to cool. A router (Ribhu via Chitragupta) is
  shown with the model that actually answered and whether the router chose
  it. Unknown values read `?`, never 0. The line drops segments by priority
  to fit `COLUMNS` instead of wrapping, and honours `NO_COLOR`/`FORCE_COLOR`
  (`tokmeter-mcp` used to force color on and override both).
  Dropped: last-call token counts, lines changed, and the live-session count.

### Fixed

- **Tokmeter would not start on Node 20 or on Node 22 before 22.15.** Both
  CLIs died at load with `SyntaxError: The requested module 'node:zlib' does
  not provide an export named 'zstdDecompressSync'`, though `engines` says
  Node 18+. The Zed parser imported zstd (added in Node 22.15) by name, which
  fails when the module loads, before any command runs; every release since
  the Zed parser (July) had it, and 1.16.0 from npm reproduces it. zstd is now
  read off the module namespace: on an older Node, compressed Codex rollouts
  are skipped with a warning naming the count, and a compressed Zed row is
  skipped like a corrupt one. CI now starts both CLIs on Node 20, because the
  test suite runs under Bun and never exercised Node's module loader.
- **`tokmeter --version` ran the default report**, and `tokmeter-mcp
  --version` was an unknown command. Both print the version now. The
  bundled CLI also looked for its package.json one level too shallow, so the
  scheduled-job command pinned `@latest` instead of the installed version.
- **Codex history was mostly missing.** Codex compresses an idle rollout to
  `rollout-….jsonl.zst` (no `.jsonl` copy remains) and moves archived threads
  to `~/.codex/archived_sessions`. tokmeter read neither: of 55,691 Codex
  responses since 2026-09-03, 46,452 were invisible, and a day whose files
  were compressed or archived before it sealed lost them. Both are read now,
  large compressed files are streamed, and fork dedup compares decompressed
  sizes so a compressed parent session isn't dropped in favour of a smaller
  fork. Days that sealed before this release keep their old totals. A Deep
  Rescan (Hub, last 30 days) grows a day back only when nothing else in it
  would shrink, so days whose other agents' logs have since aged out stay
  as they were.

## [1.16.0] - 2026-10-18

### Added

- **Chitragupta's own model calls are tracked.** Chitragupta now writes one
  usage line per model response to `~/.chitragupta/usage`, and tokmeter reads
  it under its own `chitragupta` label (`--chitragupta`). Register it in
  `~/.tokmeter/config.json` `customSources` with `provider: "chitragupta"`.
  Calls a self-metering caller like Ribhu routes through Chitragupta are
  counted once, on the caller's side.

### Fixed

- **OpenCode usage since its SQLite move was missing.** The parser queried a
  flat `messages` table; current OpenCode stores each message as JSON in
  `message.data`. The query threw and only the legacy JSON store was read, so
  every DB-era turn — models, tokens, projects — was dropped. Both stores are
  now read and merged on message id, and records carry the real project
  instead of a flat "opencode" bucket. Kilo CLI (an OpenCode fork) shares the
  reader. Run `tokmeter backfill --opencode --days 40` to fill sealed days.
  Free-tier models (`-free` / `:free`) now show $0.00 instead of
  "Unavailable": OpenCode's own catalog prices them at zero, so their $0 is a
  fact, not missing pricing.
- **SQLite-backed sources were empty under Node.** `better-sqlite3` is not a
  dependency of the published package, so the daemon and every npm install
  read nothing from OpenCode, Kilo CLI, Cursor, Codex Desktop, Zed or
  Antigravity. Node's built-in `node:sqlite` (Node ≥ 22.5) is now used first,
  with a short busy timeout so a scan that lands on a writer's lock waits
  instead of silently reading nothing. Cursor, Zed, Antigravity and Codex
  Desktop therefore start reporting under Node for the first time.
- **A response could be counted twice into a sealed day at midnight.** The
  rollover dedups yesterday's priced in-memory records against stragglers
  re-read from raw (deliberately unpriced), and the dedup fingerprint
  included `cost` — so the two copies of one response never matched. Cost is
  derived, not identity; it is no longer part of the fingerprint.
- **OpenCode's own cost is kept as reported.** It was stored as a floor but
  labelled "calculated", so any reprice replaced it with a kosha estimate.
- **Local models show $0.00, not "Unavailable".** A custom-source line whose
  routed vendor is a local runtime (Ollama, LM Studio, llama.cpp, MLX) is a
  known $0; Ollama's hosted `-cloud` models are excluded.
- **The statusline went blank whenever the daemon was busy.** `/api/today`
  waited for a full today refresh (2.5–5s measured), the statusline gave up
  at 1.5s, and Claude Code cancels any render that hasn't printed by its next
  update. Of 138 captured renders, 41% ran past 1s and showed nothing. The
  daemon now answers from what it has and refreshes afterwards; the
  statusline waits at most 300ms and otherwise shows the last good totals,
  dimmed with their age (`today ~$138 2m old`). A stopped daemon reads
  `today — daemon offline`, never $0.00.
- **A slow daemon is no longer treated as a dead one.** Every statusline
  timeout started another `daemon start` process. Only a refused connection
  starts the daemon now, at most once a minute.
- **The LaunchAgent no longer runs the daemon in launchd's Background
  class.** That class throttles disk I/O as well as CPU; under load the
  daemon got about 2% CPU and sat blocked opening its own state file for
  minutes. It now runs as Standard and still lowers its own CPU priority.
  Run `tokmeter-mcp daemon install-agent` once to pick this up.

## [1.15.1] - 2026-10-15

### Changed

- **Dependencies refreshed across the monorepo.** Biome 1.9.4 → 2.5.15
  (with the 2.x config migration), Vite 6.4.2 → 8.3.4, Chalk 5.6.2 →
  6.0.1, react-dom, and the minor-and-patch group; GitHub Actions
  (checkout, setup-node, upload-artifact) to their current majors. No
  user-visible behaviour changes.

## [1.15.0] - 2026-10-11

### Added

- **Rates panel (menubar).** A "$/M" button beside All/Today in the models
  header opens each model you used: input, output, cache read and cache
  write (5m and 1h) in dollars per million tokens, where the price came from
  (price catalog exact or fuzzy with the matched id, your override, or
  unpriced), and what you actually paid per million. Unpriced models say so
  rather than showing a guess.
- **`GET /api/rates`** on the daemon (`?scope=all` for every model with
  recorded usage) returns the same data. Each rate is derived exactly as
  billing derives it, and a fallback rule such as "2x input" is flagged as
  derived.

### Changed

- **Paper is now a broadsheet.** The menubar's Paper theme was stationery:
  rounded cards, soft shadows, grey pills and red money. It now reads like a
  newspaper front page:
  - a masthead with a dateline (today, edition number = days in your
    ledger, live session) over "The Tokmeter" nameplate and a double rule;
  - today's tokens and estimated cost as front-page figures in columns;
  - inverted ink kickers for section heads, and dotted leaders from each
    project to its cost;
  - usage details as a market page: the signals become an indicator strip
    (kicker over serif figure, columns split by hairlines), the stat cards
    become a ledger table with name, total, trend line and day change, and
    the 7-day chart and model bars are drawn in ink. Colour only marks a
    reading that needs attention;
  - money set in ink;
  - the Settings sheet and the Hub window in the same type and rules.

  The other themes' popovers render pixel-identical to before.

- **Five new menubar themes, each a real instrument.**
  - **Meter**: a utility meter under glass. Odometer drums show today's
    tokens and cost, and a ribbon speedometer shows the last hour's burn
    rate: a needle sweeping from idle toward a red zone, amber from $10/hr
    and red from $20/hr. Sub-dials show the ratios, and a sealed totalizer
    holds the all-time totals.
  - **Pump**: a fuel-pump computer. Rolling wheels show SALE, TOKENS and
    the effective $ per million today (estimated cost ÷ tokens, labelled
    as not a list price). Models are grade plates, and all-time totals sit
    on a non-resettable totalizer.
  - **Rams**: a calculator in the Braun manner. It has a dark display slab,
    and colour appears only where it means something. A clock dial shows
    the 5-hour billing block.
  - **Deck**: an 80s hi-fi deck. Cyan VFD readouts with amber money,
    segment level meters, a spectrum of daily tokens, and a tuner scale
    for model cost share.
  - **Passbook**: a savings passbook. A navy cloth cover, a dot-matrix day
    total, a teller stamp for the block's time left, and the balance
    carried forward. Its entries are labelled as estimates.

  Each theme lives in its own file behind fixed hook points: the hero,
  signals, ledger, section heads, rows, chart, tabs and cards. Adding one
  doesn't touch the shared views.

- **"Drishti" is retired from what you see.** The default CLI theme is named
  Tokmeter (its id, `default`, is unchanged, so saved configs keep working),
  the MCP package logo no longer prints the old name, and the statusline's
  cache directory is `tokmeter-<uid>`. Behind the scenes the daemon now sends
  `X-Tokmeter-API` alongside the legacy `X-Drishti-API`, and recognises the
  new daemon-child environment flag alongside the old one, so a bar, daemon or
  launchd plist from before this release keeps working with one from after it.
  The `tokmeter` MCP server name, its tools and the package name are
  unchanged. The `/tmp/drishti-daemon.{pid,token}` files remain, as
  compatibility shims for installed bars.

- **The Settings sheet follows the theme.** It used the system's material
  and appearance, so it showed as a dark grey sheet over light themes. It now
  paints the theme's surface and colour scheme, and its buttons take the
  theme's tint.

- **Plainer wording and one number format in the menubar and Hub.**
  - "Ctx drag" is "Context growth", "Block left #1" and "billing window" are
    "5-hour limit window", "7-record avg" is "7-day average", and the skins'
    metaphor headings keep the plain name beside them ("Grades · Models",
    "Hose meter · Last 30 recorded days", "Spend ledger").
  - Counts agree with their noun ("1 record", "3 turns"), not "record(s)".
  - Model, project and day amounts read as dollars and cents everywhere
    ("$144.00", "$0.056" under ten cents); K and M shorthand stays on totals.
    Model and project costs share one colour per theme.
  - Chart tooltips spell dates one way ("Sep 07, 2026").
  - The Hub's 30-day chart shows readable date labels instead of "Se…".
  - Price sources read "price catalog" with kosha named in the tooltip, and
    the Rates panel follows refreshes and clears the old scope's cards when
    you switch between Today and All.
  - The cache drawer closes with Escape and its buttons are labelled for
    VoiceOver. Restarting the usage service has its own icon, no longer a
    second circular arrow beside Refresh.

- **Editing a price override reprices today.** A change to
  `pricing-overrides.json` now reprices today's records, as a catalog update
  already did. Completed days stay frozen at the price of their day.
- **MCP tools carry annotations.** All 24 tools now declare MCP tool
  annotations, so clients can tell reads from writes: the 22 that only read
  session data are `readOnlyHint: true, openWorldHint: false`;
  `tokmeter_cleanup_execute` and `tokmeter_restore` are
  `destructiveHint: true, idempotentHint: false`.
- **Cleanup over MCP always backs up.** `tokmeter_cleanup_execute` still
  accepts `backup`, but a backup is now written even when `backup: false` is
  passed, and the result says the flag was ignored.

### Fixed

- **The menubar popover fits its content, growing and shrinking.** It used to
  leave empty bands above and below. The window grew with its content (a busy
  day, an expanded section, a theme switch) up to its 780pt cap and never
  shrank back, so a quiet day showed the panel centred in a screen-tall
  window. The layout now caps its height in a single pass, and the window
  follows the panel's height both ways with its top edge fixed under the menu
  bar.
- **Numbers and lamps that disagreed now agree.**
  - "Today" was marked on the last recorded day, even when it was weeks old,
    and Meter worked the date out once at launch, so after midnight it marked
    yesterday. It is now compared with today's date each time.
  - A stopped daemon could still show LIVE in a header lamp and a pulsing
    "live session" badge in the Hub, while the footer said OFFLINE.
  - The hero said "Cost breakdown unavailable" above a list of priced
    models; it now says "Estimate pending" with what was recorded.
  - Pump's $ per million used a different numerator from the Rates panel.
  - The Hub labels its two "today" costs: "est. API" and "est. + tool".
- **`install-mcp` now works for Claude Code.** It wrote the entry to
  `~/.claude/settings.json`, which Claude Code does not read for MCP servers.
  It now runs `claude mcp add --scope user`, or prints that command when
  `claude` isn't installed, and never edits the file. A stale `drishti` or
  `tokmeter` entry there is reported as inert.
- **`tokmeter cleanup --help`** no longer reads as if `--backup` were opt-in:
  a backup is always written.
- **macOS menubar no longer deletes custom sources from config.json.** The bar
  re-encoded only the fields its Swift struct modelled, so changing any bar
  setting (chart style, refresh interval, colour source, budget) rewrote
  `~/.tokmeter/config.json` without `customSources`, and that usage silently
  dropped out of every total. Saves now merge over the file's raw JSON: keys
  the bar doesn't model, today's and future ones, survive untouched.
- **The menubar label no longer shows stale numbers while the daemon is down.**
  It showed "?" only on an error, and the offline path clears the error, so a
  daemon that died overnight left yesterday's token count up after midnight
  (and "0 tok" on a cold launch). It now shows "?" when the daemon is
  unreachable, "…" while it starts, and a number only from a live daemon.
- **Daemon auto-start backs off.** `daemon start` exits as soon as it forks, so
  a crash-looping daemon looked like a successful start and the bar spawned
  node/npx on every poll tick, every 5s at the minimum refresh. Retries now
  back off from 15s, doubling up to 5 minutes, and reset on the first
  successful read. A failed start's reason stays on screen instead of
  flickering with "warming". Start and Restart still run immediately.
- **A reaped `/tmp` pidfile no longer reads as "daemon offline".** Liveness
  now comes from the HTTP answer. Pricing refresh, rescan and Antigravity
  fetch no longer report "offline" under a live heartbeat, and Refresh/Retry
  skip the auto-start backoff.
- **The web dashboard opens even when port 3000 is taken.** The bar's
  dashboard was fixed at 3000, which the web package's own `vite` dev server
  also binds, and failed with "Another server may be using it". It now
  defaults to **8888**, is configurable (`bar.dashboardPort` in config.json,
  `tokmeter config set bar.dashboardPort 9000`, or Hub › Settings), falls
  back to the next free port with a note saying which, and restarts on the
  new port when the setting changes.
- **Settings shows the real refresh interval** instead of a hardcoded "30s".
- **Reloads after a pricing refresh or cron install are no longer dropped**
  when a poll is already in flight, and today's figures reload at midnight and
  on wake instead of waiting up to a full refresh interval.
- **Unit boundaries round correctly:** 999,950 tokens is "1.0M", not "1000.0K";
  $999.60 is "$1.0K", not "$1000".
- **Selected chips are readable on dark themes.** White ink over a gradient
  ending in the theme's light data colour fell to about 1.3:1 on Terminal.
  Dark themes now select in their light colours under dark ink (inverse video).
- **Retired themes migrate.** A stored Synthwave, HUD, Daylight, Mint,
  Blueprint or Noise preference kept rendering while the picker showed nothing
  selected; it now maps to Terminal, Paper or Prism at launch.

- **Cleanup refuses an empty filter.** A cleanup with no project, no
  providers and no date range matched every record (an empty project string
  meant "match all"), so it deleted every transcript of every provider. The
  core now refuses it for every caller (CLI, TUI, MCP, daemon HTTP) with an
  error saying what to specify. Narrow cleanups, including provider-only or
  date-only ones, work as before.
- **Restore treats the archive as untrusted.** It used to check entries only
  for `..` and then run `tar -x` at `/`. Restore now refuses symlink,
  hardlink, device and fifo entries. It extracts into a private 0700 temp
  directory and checks the extracted tree with `lstat`. A file is copied into
  place only when its destination is inside the session paths the scanner
  reads, the Claude Code side directories, tokmeter's alias and config files,
  or the backup's own SQL dump directory. A cross-home remap must also stay
  inside `$HOME`. If any entry fails, nothing is restored. File modes and
  mtimes are kept as `tar -x` kept them, and UUID re-minting on cross-home
  collisions is unchanged. A snapshot whose meta file records another
  machine's archive path now restores from the archive next to the meta file;
  before, it failed with "Archive path outside backup directory".
- **`install-mcp` configures OpenCode where OpenCode reads it.** The entry
  goes into `~/.config/opencode/opencode.json` under `mcp`, as
  `{ type: "local", command: [...], enabled: true }`. Before, it went into
  `settings.json` under `mcpServers`, which OpenCode doesn't read. The old
  entry is removed. If you keep an `opencode.jsonc`, the installer prints the
  entry to add by hand rather than creating a second file.

- **Repricing today kept tool-reported costs.** When today's records were
  repriced (a new price catalog, or an edited `pricing-overrides.json`), costs
  reported by the tool itself (Cursor CSV, Roo, Kilo, OpenClaw, Claude Code
  `costUSD`) were reset to $0 and never restored. Only estimated costs are
  recomputed now. Completed days were never affected.
- **A restored config can't widen restore.** `config.json` is part of a backup,
  so an archive could set `providerPaths` or `customSources` to a folder such
  as `~/Library/LaunchAgents`, and the next restore would accept it. Restore
  now keeps this machine's values for both.
- **macOS app:** the dashboard port search no longer crashes when
  `bar.dashboardPort` is set within 10 of 65535.

### Security

- The macOS app updates Sparkle from 2.9.1 to 2.10.0, past a published
  advisory affecting 2.9.1 and earlier.
- Cleanup refuses an empty filter, restore extracts into a private sandbox and
  only writes under known session folders, and a restored config can no longer
  widen where a later restore may write. See Fixed for details.
- Development tooling with published advisories is updated (vitest 4.1.11,
  postcss, nanoid, source-map-js). None of it ships in the npm packages.
- A [security policy](SECURITY.md) with private vulnerability reporting.

## [1.14.1] - 2026-10-05

### Fixed

- **macOS menubar no longer builds an un-updatable app.** A build without an
  embedded Sparkle public key (a dev bundle, or one built with the key unset)
  still pointed `SUFeedURL` at the live appcast, so it tried to auto-update with
  no key to validate against and failed every time with "The update is
  improperly signed and could not be validated." The whole Sparkle auto-update
  block is now gated on the public key being present — a keyless build ships
  with no auto-update config and simply never checks, instead of nagging
  forever. Signed and release builds are unaffected; they always carry the key.
- **macOS menubar popover is now dynamic-height.** The scroll area reserved its
  full maximum height until its content measured itself, so at a low-content
  moment (start of day, no active agent) the popover opened with a large empty
  frosted gap above and below the content. It now hugs its content and only
  caps + scrolls once the content would actually overflow.

## [1.14.0] - 2026-10-03

### Added

- **Parsers for four more agents: Muse (Meta), Cline, Augment, and Copilot
  CLI.** Muse is reconciled numerically against its raw JSONL.
- **Custom sources** — register an agent tokmeter ships no parser for (one you
  built, e.g. Ribhu, or Grok) under `customSources` in `~/.tokmeter/config.json`
  and have it emit the canonical `tokmeter-usage-jsonl` line per API response.
  New provider ids: `ribhu`, `grok`, `custom`.
- **`tokmeter backfill`** — fold recent sealed days into the relay after adding
  a parser or source. `backfill --<provider>` is surgical (adds only that
  provider's slice, never re-deriving or shrinking the others); `backfill` with
  no provider is the full grow-only deep rescan.
- **Always-on daemon on macOS** — `tokmeter-mcp daemon install-agent` installs a
  launchd LaunchAgent (auto-start at login, respawn on crash), plus
  `daemon restart` and `daemon:install-agent` / `daemon:uninstall-agent`
  scripts. The agent plist is pinned to a stable node path so a `brew upgrade`
  can't orphan it.
- **macOS menubar: Start / Restart daemon controls** and an honest offline
  state — it no longer shows a "warming" skeleton (or zeros as if real) when the
  daemon is actually down or still cold-scanning. Menubar glyphs for the new
  agents.

## [1.13.0] - 2026-09-23

### Added

- `llms-install.md` so agents such as Cline can install the MCP server
  unaided, `glama.json` to claim the Glama listing, and a 400×400 logo for MCP
  directories. Releases now wait until the official MCP registry lists the new
  version.

### Changed

- **The MCP server, daemon and statusline package is now
  `@sriinnu/tokmeter-mcp`** (command `tokmeter-mcp`), replacing
  `@sriinnu/drishti`. MCP tools are renamed `drishti_*` → `tokmeter_*`, and
  editors register the server as `tokmeter`. `tokmeter-mcp install-mcp`
  removes any old `drishti` entry so an editor never runs both.
  `@sriinnu/drishti@1.12.0` stays on npm, so menubar apps that pin it keep
  working until they update.
- The daemon's wire protocol is unchanged — pidfile, token file and the
  `X-Drishti-API` header keep their names, so old and new menubar apps and
  daemons still find each other.

## [1.12.0] - 2026-09-19

This release corrects how Claude Code usage is counted and priced. Reported
costs will move — down for token counts, up for cache writes — and the two
corrections do not cancel out. Historical days already sealed keep whatever
they were sealed with unless you rescan; days with no surviving raw transcript
cannot be corrected at all.

### Added

- Show this session's cumulative tokens in the statusline, summed from the
  session's own transcript rather than the last API call, and expose the same
  figures at `GET /api/session-ledger`.
- Read the statusline from the fields Claude Code actually sends: subscription
  rate-limit windows with their reset times, prompt-cache temperature and time
  to cold, reasoning effort and extended-thinking state, the open pull request
  for the branch, and the session's added/removed line counts. Session detail
  and cross-agent totals are now separate lines.
- Record the 1-hour share of cache writes per response, so cost reflects the
  cache TTL a request actually used.

### Changed

- Treat one API response as one record. Claude Code writes an assistant turn as
  a separate line per content block, so a turn with parallel tool calls was
  previously counted once per line — on a sampled session, 252 records for 82
  calls.
- Price 1-hour cache writes at their own rate, which is higher than the
  5-minute rate carried in the pricing registry. Where the registry has no
  1-hour rate, Claude models fall back to twice the input rate, the published
  ratio; other vendors keep their own write rate, so a session pointed at a
  non-Anthropic endpoint is not overcharged.
- Price the "what would today cost on model X" comparison at the same cache TTL
  split as the actual spend, instead of quoting alternatives at the cheaper
  5-minute rate.

### Fixed

- Keep the full output token count for subagent runs. Their transcripts open
  with a placeholder usage record and only the final line carries the real
  count, so nearly all subagent output was being discarded.
- Restrict the session-ledger endpoint to transcript paths under a Claude Code
  projects directory, and bound the directory scan it performs.
- Drop a per-broadcast scan of the recent-records window that could never
  return a result.
- Match the statusline's project rollup on a whole path segment, so a project
  no longer absorbs another whose name ends with the same letters.

## [1.11.0] - 2026-09-08

### Changed

- Give today's tokens and estimated API cost equal prominence in the macOS popup, with exact daily token/cost hover details.
- Add Prism, Lagoon, and Carbon styles while preserving existing saved theme identifiers; share theme renderers across popup and Hub and document their modules.
- Refine responsive Hub layouts, heatmap keyboard navigation, chart details, and readable status/cost colors.
- Align README and skill guidance with current query, provider, pricing, and web behavior; add native build, test, and fixture rendering to CI.

### Fixed

- Start the bundled web dashboard on demand from macOS Settings, verify readiness before opening it, and provide stop/cancel and app-quit cleanup; exclude private build-machine usage exports.
- Intersect date, project, and provider filters over saved daily buckets in CLI/API summaries, including sealed-only history.
- Preserve encoded project names and query strings in native daemon requests; continue Node discovery past unsupported, broken, or hung candidates.
- Quote copied Hub project commands as literal shell arguments, correct Drishti command examples, and report settings save failures without discarding the previous configuration.
- Verify daemon process identity before signalling, publish credentials only after listener ownership, and coalesce concurrent forced rescans.

## [1.10.0] — 2026-09-06

### Changed

- The macOS opening view now leads with today's tokens, separates estimated API cost from tool-reported amounts, and shows today's projects. Secondary gauges and lifetime metrics live under Usage details.
- Model lists open on Today and retain all models behind Show all. Missing cost data is labeled Unavailable; an explicit known zero stays zero.
- Added a compatibility table, pricing methodology, synthetic-data walkthrough, and a one-week tester guide.

### Fixed

- Read Codex `token_usage_record` receipts, deduplicate mirrored legacy counters and repeated response IDs, and skip replayed parent receipts in subagents.
- Keep SQLite fallback usage separate from sessions covered by JSONL, including receipts buried before long tool output.
- Correct reasoning percentages and preserve explicit zero cache/reasoning rates and tool-reported zero costs.
- An idle local day no longer inherits the previous active day's totals in the macOS header.
- npm and macOS artifacts now include the application/core license texts and matching source; the macOS app also includes Sparkle notices and a Licenses & source control.

### Validation

See [release preparation](docs/release/1.10.0.md) for checks and [the tagged release](https://github.com/sriinnu/tokmeter/releases/tag/v1.10.0) for publication status and downloads.

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
