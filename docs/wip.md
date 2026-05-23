# Production Readiness — Work in Progress

> Status: **Pre-release (v0.4.0)** | Last updated: 2026-04-23

This document tracks everything needed before tokmeter packages can be published to npm and considered production-ready for general use.

---

## Current Grade: A- (95%)

The codebase is well-architected with good error handling, TypeScript strict mode, and clear package boundaries. Most operational infrastructure is now in place.

---

## ✅ COMPLETED — Critical Items

### 1. Package Metadata ✅

All 5 packages now have essential npm fields:

- [x] `@sriinnu/tokmeter-core` — `packages/core/package.json`
- [x] `@sriinnu/tokmeter-cli` — `packages/cli/package.json`
- [x] `@sriinnu/tokmeter-tui` — `packages/tui/package.json`
- [x] `@sriinnu/tokmeter-web` — `packages/web/package.json`
- [x] `@sriinnu/drishti` — `packages/mcp/package.json`

Each package now includes: `license`, `author`, `repository`, `keywords`, `engines`, `publishConfig`.

---

### 2. Tests ✅

Basic test coverage is in place with vitest:

#### Core (`packages/core/`)
- [x] PricingService tests — instance creation, initialization, pricing lookups

#### MCP/Drishti (`packages/mcp/`)
- [x] Formatter tests — `formatNumber()`, `formatCost()`, `formatPercent()`, `formatBar()`, `formatDuration()`, `sparkline()`

**Test runner:** vitest (configured in `vitest.config.ts`)

**Scripts:**
- `bun test` — run tests
- `bun run test:watch` — watch mode

---

### 3. CI/CD ✅

GitHub Actions workflows are in place:

- [x] `.github/workflows/ci.yml` — Build + Test on PR
- [x] `.github/workflows/publish.yml` — Publish to npm on release

---

### 4. Error Handling ✅

Process-level handlers added to all CLI entry points:

- [x] `packages/cli/src/cli.ts`
- [x] `packages/mcp/src/cli.ts`
- [x] `packages/tui/src/index.tsx`

---

### 5. Linting & Formatting ✅

Biome is configured:

- [x] `biome.json` — formatter and linter config
- [x] Scripts: `lint`, `lint:fix`, `format`

---

### 6. CHANGELOG ✅

- [x] `CHANGELOG.md` created following Keep a Changelog format

---

### 7. Universal Installer Commands ✅

New CLI commands for installing statusline and MCP across ALL editors:

- [x] `drishti install-statusline` — Install statusline hook for ALL supported editors
- [x] `drishti install-mcp` — Install MCP server for ALL supported editors
- [x] `drishti uninstall-statusline` — Remove statusline hook from all editors
- [x] `drishti uninstall-mcp` — Remove MCP server from all editors
- [x] `drishti editors` — List all supported editors

**Supported editors:**
- Claude Code (~/.claude/settings.json)
- OpenCode (~/.config/opencode/settings.json)
- Codex (~/.codex/settings.json)
- Cursor (~/.cursor/mcp.json)
- Windsurf (~/.windsurf/mcp.json)
- Zed (~/.config/zed/settings.json)
- VS Code Copilot (~/.vscode/settings.json)

---

## What's Already Good

| Area | Status |
|------|--------|
| TypeScript strict mode | ✅ |
| Declaration files (.d.ts) | ✅ |
| Bin entries with shebang | ✅ |
| `files` array (dist-only publish) | ✅ |
| Security (no secrets, safe I/O) | ✅ |
| Symlink attack prevention | ✅ |
| Error handling in parsers | ✅ |
| README.md per package | ✅ |
| SKILL.md per package | ✅ |
| MIT license | ✅ |
| Git remote configured | ✅ |
| Monorepo workspace setup | ✅ |
| ESM with proper exports map | ✅ |
| Process-level error handlers | ✅ |
| CI/CD workflows | ✅ |
| Linting (Biome) | ✅ |
| Tests (vitest) | ✅ |
| Universal installer | ✅ |

---

## LOW — Nice to have

### 8. Documentation Site

Consider a docs site (VitePress, Nextra, or GitHub Pages) for:
- API reference for `@sriinnu/tokmeter-core`
- MCP tool documentation for drishti
- Screenshots / GIFs of TUI and statusline
- Configuration guides per CLI (Claude Code, Codex, Cursor, etc.)

### 9. npm Dry Run Verification

Before each publish, run:
```bash
for pkg in core cli tui mcp; do
  echo "=== packages/$pkg ===" && cd packages/$pkg && npm pack --dry-run && cd ../..
done
```

Verify that `src/`, `tsconfig.json`, `.tsbuildinfo` are NOT included.

### 10. Workspace Versioning

Consider `changesets` for coordinated versioning across the monorepo:
```bash
bun add -d @changesets/cli -w
npx changeset init
```

This automates: version bumps, changelog generation, and npm publish across dependent packages.

### 11. ccusage-Inspired Improvements

From the ccusage research, these patterns would improve accuracy:
- [ ] **Deduplication** by `messageId:requestId` — prevents double-counting on replayed sessions
- [ ] **Tiered pricing** — Anthropic charges different rates above 200K tokens
- [ ] **5-hour billing block grouping** — matches Anthropic's actual billing windows
- [ ] **Stream-based JSONL parsing** — line-by-line for memory efficiency on large sessions

---

## Publish Checklist (when ready)

```bash
# 1. Ensure all checks pass
bun run build
bun test
bun run lint

# 2. Verify package contents
for pkg in core cli tui mcp; do
  echo "=== packages/$pkg ===" && cd packages/$pkg && npm pack --dry-run && cd ../..
done

# 3. Tag release
git tag v0.1.0
git push origin v0.1.0

# 4. Publish (order matters — core first, others depend on it)
cd packages/core && npm publish --access public
cd packages/cli && npm publish --access public
cd packages/tui && npm publish --access public
cd packages/mcp && npm publish --access public

# 5. Create GitHub release
gh release create v0.1.0 --title "v0.1.0 — Initial Release" --notes "See CHANGELOG.md"
```

---

## Quick Start for Users

### Install statusline for ALL editors:
```bash
npx -y @sriinnu/drishti install-statusline
```

### Install MCP for ALL editors:
```bash
npx -y @sriinnu/drishti install-mcp
```

### Install for specific editor:
```bash
npx -y @sriinnu/drishti install-statusline claude cursor
npx -y @sriinnu/drishti install-mcp claude opencode
```

---

## Performance & freshness hardening — 2026-05-22

Root-cause work on the RAM/kernel-panic class of bugs and on history
immutability. See [architecture.md](architecture.md) and the CHANGELOG
`[Unreleased]` section for detail.

**Landed:**
- History immutability: stop re-pricing frozen history; append-only snapshot
  rollover; monotonic floor guard; append-boundary record-loss fix.
- KPI cards no longer show frozen lifetime totals as "depleting" mid-day.
- Core: mtime-pruned today scans + `TokmeterCore.refreshToday()` warm path.
- macOS bar: reads the daemon only and auto-starts the singleton daemon when
  offline; removed the per-fetch CLI-scan fallback that spawned a stampede of
  multi-GB processes (the kernel-panic trigger).

**Remaining (next session):**
- Daemon: stay warm and refresh only today via `refreshToday()` instead of a
  full `core.scan()` on a short TTL.
- Statusline: read the daemon's `/api/today` instead of running its own
  `core.scan({ today: true })`.
- Daemon: hard cross-process singleton (PID guard + `EADDRINUSE`) and process
  rails (guaranteed exit, bounded heap on spawn).
- Verification: simulate multiple concurrent Claude + Codex sessions hammering
  the statusline/daemon; measure RSS + process count; confirm token/cost stays
  accurate under load (warm-daemon numbers == ground-truth full scan).
