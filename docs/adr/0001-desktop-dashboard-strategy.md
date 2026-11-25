# ADR 0001: Desktop Dashboard Strategy, Wire Contracts & React Isolation

- **Status:** Accepted
- **Date:** 2026-11-25
- **Issue:** [#297](https://github.com/sriinnu/tokmeter/issues/297)

## Context

Tokmeter currently serves desktop users through two UI stacks across three languages/runtimes:

1. **Native macOS menubar app (`packages/macos-bar`)**: A ~23k LOC Swift/SwiftUI app owning the menubar status item, themed popover cards, live daemon lifecycle management, Sparkle auto-updates, and a native desktop Hub window (`Hub*.swift`, ~7k LOC across 23 files).
2. **React web dashboard (`packages/web`)**: A ~9.3k LOC React 19 + Recharts + Three.js application served locally by `tokmeter web` and also bundled offline into `TokmeterBar.app` via `WebDashboardController.swift`.
3. **Wire schema duplication & React split**:
   - `packages/web` previously redeclared `TokmeterSummary`, `DailyEntry`, `ModelSummary`, `ProjectSummary`, `TokenRecord` (`RawRecord` casts), and `TimeOfDayProfile` instead of importing them from `@sriinnu/tokmeter-core`.
   - `packages/macos-bar` mirrors daemon JSON payloads in Swift `Codable` structs (`Models.swift`, `RatesModels.swift`, `QuotaModels.swift`, `TimeOfDay.swift`) without a shared CI-verified wire contract against the daemon HTTP handlers.
   - `packages/tui` and `packages/mcp` depend on `ink@^5.0.0`, which pins `react@^18.3.0`, whereas `packages/web` runs `react@^19.3.1`.

## Decisions

### 1. Canonical Full-Window Desktop Analytics Surface (`packages/web`)
`packages/web` is the canonical full-window analytics dashboard across all platforms (`tokmeter web` and the in-app dashboard bundled in `TokmeterBar.app`).
- New multi-chart analytics views, 3D visualizations, and table drilldowns live exclusively in `packages/web`.
- We will not build parallel analytics views in SwiftUI.

### 2. Canonical Native macOS Role (`packages/macos-bar`)
`packages/macos-bar` focuses on what only a native AppKit/SwiftUI menubar app can do well:
- Glanceable menubar indicator + compact popover (`Burn Rate`, `Plan Quota`, `Context Pressure`, `Cost`, `Themes`).
- Single-instance daemon lifecycle management, LaunchAgent daily refresh status, and Sparkle signed auto-updates.
- Hosting the bundled `packages/web` dashboard in `WebDashboardController`.

### 3. Native Swift Hub Window (`Hub*.swift`) Freeze Path
`Hub*.swift` is frozen for new analytics features (bug fixes and contract maintenance only).
- Native settings and operational controls (appearance/skins, login item, daily refresh cron, kosha pricing status, daemon logs/controls) remain native and will be consolidated into a lightweight native Preferences sheet before retiring duplicated native Hub analytics tabs.

### 4. Direct TypeScript Type Sharing (`packages/web` → `@sriinnu/tokmeter-core`)
`packages/web` imports canonical summary, rollup, meta, time-of-day, and record wire types directly from `@sriinnu/tokmeter-core` via erased `import type` statements (`noEmit` + Vite TypeScript type erasure).
- No Node runtime code from `packages/core` is pulled into browser bundles.
- Ad-hoc `RawRecord` interfaces and `as unknown as RawRecord` casts are prohibited.

### 5. Cross-Language Daemon API Contract (`contracts/daemon-api-contract.json`)
Daemon HTTP endpoints consumed by `packages/macos-bar` are anchored by a canonical contract fixture (`contracts/daemon-api-contract.json`) verified in CI on both sides:
- **TypeScript (`packages/mcp/src/daemon/daemon-contract.test.ts`)**: Boots an isolated daemon HTTP server with sealed + live data and validates every endpoint response shape against `contracts/daemon-api-contract.json` alongside compile-time core/daemon types.
- **Swift (`packages/macos-bar/Tests/TokmeterBarTests/DaemonContractTests.swift`)**: Decodes every section of `contracts/daemon-api-contract.json` using the production Swift `Codable` wire structs via `JSONDecoder`.

### 6. React 18 / React 19 Workspace Boundary
`packages/tui` and `packages/mcp` stay on `react@^18.3.0` as required by `ink@^5.0.0`.
- `packages/web` remains isolated as a private browser-only Vite package on `react@^19.3.1` with zero dependency on `packages/tui` or `packages/mcp`.
- Do not mix React 18 and React 19 inside the same package or bundle; unify `packages/tui`/`packages/mcp` only after Ink officially supports React 19.

## Consequences

- **One place for heavy analytics UX**: Contributors add new full-screen views once in `packages/web` instead of twice across React and SwiftUI.
- **Zero silent cross-language drift**: Changing a field in a daemon HTTP handler without updating both `contracts/daemon-api-contract.json` and Swift `Codable` models fails CI immediately.
- **Preserved browser isolation**: Type-only imports give full compiler safety across core and web without risking Node API leakage into Vite builds.
