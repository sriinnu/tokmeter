# Production Readiness — Work in Progress

> Status: **Pre-release (v0.1.0)** | Last updated: 2026-04-01

This document tracks everything needed before tokmeter packages can be published to npm and considered production-ready for general use.

---

## Current Grade: B- (70%)

The codebase is well-architected with good error handling, TypeScript strict mode, and clear package boundaries. What's missing is the operational infrastructure around it.

---

## CRITICAL — Must fix before npm publish

### 1. Package Metadata

All 5 packages are missing essential npm fields. Each `package.json` needs:

```json
{
  "license": "MIT",
  "author": "Srinivas Pendela <sriinnu@agentiqx.ai>",
  "repository": {
    "type": "git",
    "url": "https://github.com/sriinnu/tokmeter.git",
    "directory": "packages/<name>"
  },
  "keywords": ["tokens", "ai", "llm", "usage-tracking", "pricing"],
  "engines": { "node": ">=22.0.0" },
  "publishConfig": { "access": "public" }
}
```

**Packages to update:**
- [ ] `@tokmeter/core` — `packages/core/package.json`
- [ ] `@tokmeter/cli` — `packages/cli/package.json`
- [ ] `@tokmeter/tui` — `packages/tui/package.json`
- [ ] `@tokmeter/web` — `packages/web/package.json`
- [ ] `@tokmeter/drishti` — `packages/mcp/package.json`

**Effort:** ~30 minutes

---

### 2. Tests — Zero Coverage

No test files, no test runner, no test scripts exist anywhere in the repo. This is the single biggest risk — a broken kosha update or parser regression ships silently.

**Minimum viable test suite:**

#### Core (`packages/core/`)
- [ ] **Pricing tests** — `PricingService.getPricing()` returns correct rates for all tiers (static, kosha direct, kosha fuzzy)
- [ ] **Pricing calculation** — `calculateCost()` with known inputs produces expected USD amounts
- [ ] **Parser output shapes** — each of the 16 parsers returns valid `TokenRecord[]` (or empty array for missing data)
- [ ] **Aggregator** — `getModelCosts()`, `getDailyBreakdown()`, `getStats()` produce expected shapes
- [ ] **Date filtering** — `scan({ today: true })`, `scan({ since, until })` filter correctly

#### CLI (`packages/cli/`)
- [ ] **Smoke test** — `tokmeter --json` exits 0 and produces valid JSON
- [ ] **Help** — `tokmeter --help` exits 0

#### MCP/Drishti (`packages/mcp/`)
- [ ] **Statusline** — piped JSON produces non-empty output with expected segments
- [ ] **Formatter** — `formatNumber()`, `formatCost()`, `formatBar()`, `sparkline()` produce expected strings
- [ ] **Tracker** — `computeTokenBreakdown()` and `snapshotHash()` produce expected values

**Test runner:** vitest (already a devDependency of @sriinnu/kosha-discovery, consistent with the ecosystem)

**Setup needed:**
```bash
bun add -d vitest -w          # root workspace
```

Root `vitest.config.ts`:
```typescript
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts"],
  },
});
```

Root `package.json` script:
```json
{ "test": "vitest run", "test:watch": "vitest" }
```

**Effort:** ~4-6 hours for minimum viable coverage

---

## HIGH — Should fix before public announcement

### 3. CI/CD — No GitHub Actions

No `.github/workflows/` directory exists. Need at minimum:

#### `.github/workflows/ci.yml` — Build + Test on PR
```yaml
name: CI
on: [push, pull_request]
jobs:
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run build
      - run: bun test
```

#### `.github/workflows/publish.yml` — Publish to npm on release
```yaml
name: Publish
on:
  release:
    types: [created]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install && bun run build
      - run: npm publish --workspace packages/core
      - run: npm publish --workspace packages/cli
      - run: npm publish --workspace packages/tui
      - run: npm publish --workspace packages/mcp
    env:
      NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

**Effort:** ~2 hours

---

### 4. Error Handling — Missing Process-Level Handlers

CLI entry points (`cli/src/cli.ts`, `mcp/src/cli.ts`) need:

```typescript
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});
```

Without this, a rejected promise in a parser silently kills the process with no output.

**Files to update:**
- [ ] `packages/cli/src/cli.ts`
- [ ] `packages/mcp/src/cli.ts`
- [ ] `packages/tui/src/index.tsx`

**Effort:** ~30 minutes

---

## MEDIUM — Should fix before v1.0

### 5. Linting & Formatting

No ESLint, Prettier, or Biome config. Code is well-formatted by convention but not enforced.

**Recommended setup:**
```bash
bun add -d @biomejs/biome -w
```

`biome.json`:
```json
{
  "formatter": { "indentStyle": "space", "indentWidth": 2 },
  "linter": { "enabled": true },
  "javascript": { "formatter": { "semicolons": "always" } }
}
```

Root script:
```json
{ "lint": "biome check .", "lint:fix": "biome check --write ." }
```

Pre-commit hook via `.git/hooks/pre-commit` or `husky`:
```bash
bun run lint
```

**Effort:** ~1 hour

---

### 6. CHANGELOG

No `CHANGELOG.md` exists. Create one following [Keep a Changelog](https://keepachangelog.com/):

```markdown
# Changelog

## [0.1.0] - 2026-04-01

### Added
- Core token tracking engine with 16 provider parsers
- 4-tier pricing via @sriinnu/kosha-discovery (20+ providers)
- CLI with table, JSON, and pricing lookup modes
- Interactive TUI with bar charts, sparklines, heatmaps
- React + Plotly web dashboard
- Drishti MCP server with 16 tools
- Statusline hook for Claude Code (TrueColor, project/branch, per-model breakdown)
- macOS menu bar app (Swift)
- README.md and SKILL.md for all packages
```

**Effort:** ~30 minutes

---

## LOW — Nice to have

### 7. Documentation Site

Consider a docs site (VitePress, Nextra, or GitHub Pages) for:
- API reference for `@tokmeter/core`
- MCP tool documentation for drishti
- Screenshots / GIFs of TUI and statusline
- Configuration guides per CLI (Claude Code, Codex, Cursor, etc.)

### 8. npm Dry Run Verification

Before each publish, run:
```bash
cd packages/core && npm pack --dry-run
cd packages/cli && npm pack --dry-run
cd packages/mcp && npm pack --dry-run
```

Verify that `src/`, `tsconfig.json`, `.tsbuildinfo` are NOT included (the `"files": ["dist"]` field handles this, but always verify).

### 9. Workspace Versioning

Consider `changesets` for coordinated versioning across the monorepo:
```bash
bun add -d @changesets/cli -w
npx changeset init
```

This automates: version bumps, changelog generation, and npm publish across dependent packages.

### 10. ccusage-Inspired Improvements

From the ccusage research, these patterns would improve accuracy:
- [ ] **Deduplication** by `messageId:requestId` — prevents double-counting on replayed sessions
- [ ] **Tiered pricing** — Anthropic charges different rates above 200K tokens
- [ ] **5-hour billing block grouping** — matches Anthropic's actual billing windows
- [ ] **Stream-based JSONL parsing** — line-by-line for memory efficiency on large sessions

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
