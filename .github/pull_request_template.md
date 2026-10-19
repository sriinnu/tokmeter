## Why

<!-- What was wrong or missing, and how you know. -->

## What changed

## How you checked it

<!-- Commands run, before/after output. For a parser or accounting change:
     the comparison against an independent count from the raw files. -->

- [ ] `bun run build && bun run test && bun run lint` pass
- [ ] `swift test --package-path packages/macos-bar` (if the macOS app changed)
- [ ] Parser derivation changed → `CACHE_VERSION` bumped
- [ ] User-visible change → line under `## [Unreleased]` in CHANGELOG.md
