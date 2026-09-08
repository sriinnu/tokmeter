# On-demand web dashboard

Settings → **Open web dashboard** starts a child server owned by TokmeterBar, waits for that child's readiness response, then opens `http://127.0.0.1:3000/`. Reopening reuses the child. **Stop web dashboard** closes it; **Cancel dashboard startup** cancels an in-progress launch. Quitting the app closes the child too. Closing a browser tab alone does not stop it.

The dashboard needs Node.js 18+ and the usage daemon used by the menubar. Stopping the dashboard leaves the daemon and menubar updates running. Missing assets, an unavailable Node runtime, and startup/port failures appear in Settings. If another program owns port 3000, Tokmeter refuses to open or stop that program.

## Module ownership

| Module | Responsibility |
| --- | --- |
| `WebDashboardController.swift` | Observable native lifecycle, supported Node discovery, owned child/stdin, nonce readiness, browser opening, stop/cancel and app-quit cleanup |
| `SettingsPopover.swift` | Start/open, stop/cancel and error controls |
| `packages/web/scripts/dashboard-server.mjs` | Node standard-library HTTP server, local read-only routing, summary proxy, asset bounds and stdin/signal shutdown |
| `packages/web/vite.config.ts` | App-build mode disables public-file copying |
| `packages/web/scripts/app-notices.ts` | Collects installed dependency license texts from the actual web bundle modules; a missing notice fails the app build |
| `packages/macos-bar/bundle.sh` | Builds and bundles only dashboard HTML, hashed assets, and the server script before signing |

The optional server binds IPv4 loopback, accepts only its own localhost Host/Origin, and exposes GET requests. `/api/summary` forwards to the existing daemon on port 9877 with a timeout and bounded response. SPA routes render the app shell; realpath checks keep asset reads within the bundled dashboard directory. It does not expose daemon mutations or serve `data.json`. These are application checks, not OS sandbox containment.

The build bundles web dependency notices in `Resources/Licenses/WebThirdPartyNotices.txt` and deliberately excludes the developer's `public/data.json`. A failed live summary displays an error instead of falling back to somebody else's packaged usage history. Development/preview and intentional static exports retain the separate behavior described in the [web README](../../packages/web/README.md).

## Verify a change

Run `bunx vitest run packages/web/src/server/dashboard-server.test.ts` and `swift test --package-path packages/macos-bar --filter WebDashboardTests`. Tests use temporary assets, an ephemeral fixture upstream, and actual child/listener lifecycle checks; native tests open through an injected browser callback. They cover route reloads, summary provenance/failure, foreign requests, path escape/private-export refusal, port contention, EOF stop/restart, and cancellation.

Build the app, inspect `Contents/Resources/Dashboard` for only the intended code assets, then open its server in a real browser. Check the overview, projects, models, timeline and 3D views; reload a subpage and confirm current data, stop/restart, and app-quit behavior. Browser rendering and native Settings clicks are distinct from the automated callback tests.
