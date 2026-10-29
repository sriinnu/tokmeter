# Contributing to Tokmeter

Thanks for helping. Tokmeter is small and opinionated about one thing: the
numbers have to be right. Most of this page is about how to keep them right.

## Before you start

- **Bugs:** open an issue with `tokmeter --version`, your Node version
  (`node --version`), your OS, and which agent the numbers are wrong for.
  "Total looks high" is hard to act on; "Codex on 10-07 shows 582M, the raw
  files add up to 760M" is a fix.
- **A new agent:** open an "Add support for an agent" issue first, with where
  the agent writes its session files and a redacted sample line that carries
  token usage.
- **Security issues** go through [private reporting](SECURITY.md), never a
  public issue.
- Bigger changes (new commands, new storage, anything touching the relay
  ledger): open an issue to agree on the shape before writing the code.

## Setup

You need [Bun](https://bun.sh) and Node 20 or newer. The macOS app also needs
Xcode 16+.

```sh
bun install
bun run build     # every package, in dependency order
bun run test      # vitest
bun run lint      # biome
swift test --package-path packages/macos-bar   # macOS app, if you touched it
```

Run all of them before you open a PR; CI runs the same gate and also starts
both CLIs on Node 20.

Two things that bite:

- `@sriinnu/tokmeter` is a copy of core, CLI and TUI made at build time.
  After changing `packages/core`, run `bun run build` (or
  `bun run build:tokmeter`), or the CLI and daemon keep running the old code.
- Tests run under Bun; users run Node. Anything Node-version-specific (new
  `node:` APIs) has to be imported so that an older Node can still load the
  module; check the `engines` range.

## The accounting rules

These come from real bugs, each of which shipped wrong numbers once.

- **One record per API response.** Agents write a turn as several lines.
  Dedup on the provider's response id (`message.id` for Claude Code,
  `payload.response_id` for Codex), never on a timestamp.
- **Keep the max per bucket across a turn's lines,** not the first value seen:
  some transcripts open with a placeholder and only the last line has the real
  counts.
- **Sub-buckets are subsets.** `cacheWrite1hTokens` is part of
  `cacheWriteTokens`; adding both counts the same tokens twice.
- **Never validate Tokmeter with Tokmeter.** Prove a parser change against an
  independent count built straight from the raw files (a short script that
  reads the JSONL and dedups on the response id), and put the comparison in
  the PR.
- **Bump `CACHE_VERSION`** in `packages/core/src/parsers/utils.ts` whenever a
  parser changes how tokens or cost are derived, or cached records from the
  old parser survive the fix.
- **Sealed days are history.** `~/.cache/tokmeter/aggregates/` is the
  durable ledger, often the only copy once agents rotate their logs. Code may
  only grow a sealed day; never write anything that can shrink one silently.

## Adding an agent

1. A parser in `packages/core/src/parsers/`, registered in `index.ts`.
2. Tests with a small fixture of real (redacted) lines, including the cases
   that break naive parsers: repeated lines per turn, resumed or forked
   sessions, and a malformed line.
3. The comparison against an independent count, in the PR description.
4. A row in [docs/compatibility.md](docs/compatibility.md).

An agent Tokmeter has no parser for can still report usage without code
changes: register it under `customSources` in `~/.tokmeter/config.json` and
have it write the `tokmeter-usage-jsonl` line format described in
the [tokmeter skill](https://github.com/sriinnu/tokmeter-skill/blob/main/skills/tokmeter/SKILL.md) (see "Custom sources" in
[docs/compatibility.md](docs/compatibility.md)).

## Pull requests

- Branch from `main` and open a PR against it. `main` only takes squash
  merges, and the maintainer reviews every change.
- Write the description about **why**, with evidence: what was wrong, how you
  proved it, and what you checked after the fix.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  anything a user would notice.
- Keep PRs to one change. A parser fix and a refactor are two PRs.

## Code of conduct

Everyone taking part is expected to follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## License

By contributing you agree that your contribution is licensed under the
project's [AGPL-3.0-only](LICENSE) license.
