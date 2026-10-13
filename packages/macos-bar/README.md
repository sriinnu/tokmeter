# TokmeterBar — macOS menubar companion

A native SwiftUI `MenuBarExtra` and companion Hub for local token usage and cost telemetry. Release builds target Apple silicon and macOS 14+.

## Start

Install Node.js 18+ with npx, then open TokmeterBar from `/Applications`.
The current source discovers paired Node/npx in common system and managed installations and starts the version-matched `@sriinnu/tokmeter-mcp` daemon when it is unavailable. The first download needs network access. Missing prerequisites and startup failures show an explanation and Retry control.

For older 1.10.0 builds, install and start the daemon explicitly (it shipped as `@sriinnu/drishti` before 1.13.0):

```sh
npm install -g @sriinnu/drishti@1.10.0
drishti daemon start
open /Applications/TokmeterBar.app
```

The app reads HTTP telemetry from `http://127.0.0.1:9877`. It does not run a separate full-history CLI scan for each refresh. See [first-use validation](../../docs/macos/first-use.md).

## Use

The menubar shows today's tokens. Open it for estimated API cost, tool-reported cost when available, and today's models and projects. The full **Usage details** row expands lifetime totals, trends, and signals. The popup fits its content and scrolls when it reaches the available height. The Hub offers larger breakdowns and settings.

Eleven themes are selectable: Terminal, Paper, Prism, Lagoon, Carbon, Glass, and, since 1.15.0, five instrument themes. Paper is a broadsheet (popover, Settings sheet, and Hub), and the instrument themes are Meter (utility meter with odometer drums and a burn-rate gauge), Pump (fuel-pump display), Rams (calculator), Deck (hi-fi display), and Passbook (savings passbook). Each new theme also styles the footer and the Hub. Prism replaces Nebula and retains the stored `nebula` identifier. Carbon replaces Nocturne; Lagoon replaces Aurora. Their stored identifiers remain `nocturne` and `aurora` so existing preferences continue to decode. Glass uses native light desktop frost, dark ink, and explicit theme-based status colors; Reduce Transparency selects an opaque fallback. The footer separates version and licensing from pricing status.

Refresh frequency is configurable. Since 1.15.0, the **$/M** button in the models header opens a rates panel. For each model used today, or all time, it lists the list price per million tokens for input, output, cache read, and cache write (5-minute and 1-hour). It also shows where each price came from (your override, an exact or fuzzy kosha match, or unpriced) and the estimated average paid per million. Costs are not a verified subscription bill; missing cost data is shown as unavailable. See [how the numbers work](../../docs/how-the-numbers-work.md) and [popover validation](../../docs/macos/popover-usability.md).

Settings → **Open web dashboard** starts a local dashboard server when needed and opens it after readiness. **Stop web dashboard** stops that child; quitting the app also stops it. The usage daemon continues independently. From the release after v1.14.1 the dashboard prefers port 8888, configurable in Hub → Settings → Dashboard port or with `tokmeter config set bar.dashboardPort <port>` (1024–65535). If another server holds that port, it opens on the next free one and says so. See [dashboard lifecycle and development](../../docs/macos/web-dashboard.md).

## Build and test

Install Xcode, then run from the repository root:

```sh
bun run bar:build       # build an ad-hoc signed .app without installing
bun run bar             # build, install to /Applications, and launch
swift test --package-path packages/macos-bar
```

The bundle script creates `packages/macos-bar/TokmeterBar.app`, includes license texts and source, and signs it. Local ad-hoc signing does not provide Developer ID or notarization.

For optional synthetic UI captures, create an output directory and set `TOKMETER_UI_QA_DIR` before running the native tests. These fixtures read no local usage. Live pointer, keyboard, and VoiceOver checks remain separate.

## Architecture

- `TokmeterBarView.swift` and `UsageOverview.swift`: popup layout and disclosure.
- `TokmeterLoader.swift`: observable telemetry, refresh, and connection state.
- `NodeToolchain.swift` and `SubprocessRunner.swift`: Node discovery and bounded startup commands.
- `DaemonClient.swift`: version-checked REST client.
- `Theme.swift`, `ThemePalettes.swift`, and `Theme+Modes.swift`: identity, colors, and visual modes.
- `Broadsheet.swift`, `HubBroadsheet.swift`: Paper's newspaper primitives.
- `Skins.swift`, `SkinFooter.swift`, `HubSkin.swift`, and `Skin+<Name>.swift`: the instrument themes, each in its own file behind fixed hook points.
- `PanelStack.swift`: the popover's single-pass height cap.
- `RatesPanel.swift`, `RatesModels.swift`, `DaemonClient+Rates.swift`: the $/M rates panel.
- `PrismSurface.swift` and `FrostedGlass.swift`: reusable surface drawing shared by the popup and Hub.
- `HubView.swift`: full-window companion.

See [native theme development](../../docs/macos/themes.md) for module ownership, adding styles, stored identifiers, and render checks.

GET endpoints cover quick/readiness state, stats, daily usage, models, sessions/projects, signals, pricing, and health. User-triggered pricing updates, deep rescans, and live Antigravity fetches use POST requests authenticated by the daemon's local bearer token. See `DaemonClient.swift` for the exact routes.

## Distribution

The existing scripts support Developer ID signing, notarization, stapling, Sparkle update metadata, and ZIP packaging:

```sh
bun run bar:signed      # Developer ID signed bundle
bun run bar:release     # signed, notarized, stapled ZIP and appcast entry
```

These commands require the configured Apple distribution credentials and Sparkle signing key. See [the release pipeline](RELEASE.md). Publishing is a separate step. The [six-area completion tracker](../../docs/macos-completion.md) records acceptance work still open; a successful build does not close it.

## License

AGPL-3.0-only — [license text](../../LICENSE). Core source retains MPL-2.0. The footer's **Licenses** button opens `Contents/Resources/Licenses/`, containing both texts, Sparkle notices, and the build source snapshot. See [licenses and source](../../docs/licensing.md).
