# TokmeterBar — macOS menubar companion

A native menubar app that shows live token usage and cost from the Drishti
daemon. Built with SwiftUI's `MenuBarExtra`.

## Architecture

```
                ┌─────────────────────┐
                │  TokmeterBar.app    │
                │  (SwiftUI menubar)  │
                └──────────┬──────────┘
                           │ HTTP GET
                           │ http://127.0.0.1:9877/api/*
                           ▼
                ┌─────────────────────┐
                │  Drishti Daemon     │
                │  (Node.js)          │
                └──────────┬──────────┘
                           │ scans
                           ▼
                ~/.claude /.codex / etc.
```

The app connects to the Drishti daemon's HTTP REST API on `localhost:9877`.
The daemon must be running:

```sh
drishti daemon start
```

## Build

```sh
cd packages/macos-bar
./bundle.sh             # build + create TokmeterBar.app
./bundle.sh --install   # also copy to /Applications
```

This builds with `swift build -c release`, wraps the binary in a proper `.app`
bundle with `Info.plist` (`LSUIElement=true` so it has no Dock icon), and
ad-hoc signs it so macOS Gatekeeper allows local execution.

## Run

```sh
# Start the daemon if it isn't already
drishti daemon start

# Launch the app
open TokmeterBar.app
```

The menubar icon shows `♾️ $X.YY` (today's cost). Click it to see:
- Today / Total Tokens / Total Cost
- Top 3 models bar chart
- 7-day cost line chart
- Projects / Active Days / Streak

It refreshes every 30 seconds.

## File layout

```
packages/macos-bar/
├── Package.swift                       — SPM manifest
├── bundle.sh                           — build + bundle script
├── Sources/TokmeterBar/
│   ├── TokmeterBarApp.swift            — @main App entry point
│   ├── TokmeterBarView.swift           — SwiftUI popover content
│   ├── TokmeterLoader.swift            — observable loader (timer + async fetch)
│   ├── DaemonClient.swift              — HTTP client for the daemon REST API
│   └── Models.swift                    — data shapes
└── README.md                           — this file
```

## Daemon API endpoints used

| Method | Path             | Purpose                                     |
|--------|------------------|---------------------------------------------|
| GET    | `/api/stats`     | Total cost, total tokens, projects, streak  |
| GET    | `/api/daily`     | Daily breakdown (used for today + 7-day)    |
| GET    | `/api/models`    | Per-model cost ranking (top 3 displayed)    |

GET endpoints are read-only and require no authentication. POST endpoints
(cleanup, restore) require a bearer token from `/tmp/drishti-daemon.token`
but the menubar app doesn't currently use them.

## Distribution

For local use, the ad-hoc signature in `bundle.sh` is enough. For
distribution outside your machine you'd need:

1. An Apple Developer ID certificate
2. Replace `codesign --sign -` with `codesign --sign "Developer ID Application: Your Name"`
3. Run `xcrun notarytool submit` to notarize
4. Build a DMG with `create-dmg` or similar

Not implemented yet — only ad-hoc local builds.
