# Web dashboard

Browser dashboard for token and cost data. Built with React, Tailwind CSS v4 and shadcn/ui-style components, with Recharts for 2D charts and three.js for the 3D view.

## Setup

The macOS app bundles this dashboard. Choose **Open web dashboard** in its Settings to start the server, and **Stop web dashboard** to stop it. It also stops when the app quits. This mode reads the existing daemon and excludes build-machine usage exports; see [the lifecycle guide](../../docs/macos/web-dashboard.md).

For source development, this remains a private workspace package:

```bash
# From the repository root
bun install
bun run dev:web
```

Vite opens the private local URL in your browser. It sets a session cookie and
removes the launch code from the address bar. Restart `dev:web` if you close the
browser before the page opens; a plain `http://127.0.0.1:3000` request has no
access to your usage data.

### Data

Both the development server and Vite preview protect their pages and data with
a per-launch browser session. They serve `/api/summary` by scanning local
session data, with a persisted-summary fallback, and proxy `/api/live` through
the owner's daemon credential. The browser tries the summary endpoint before
`/data.json`, so an exported file does not override a working live endpoint.

For a static export, install Python 3, then run from the repository root:

```bash
umask 077
mkdir -p packages/web/public
npx @sriinnu/tokmeter --json > packages/web/public/data.json
bun run build:web
python3 -m http.server 3000 --bind 127.0.0.1 --directory packages/web/dist
```

Open http://127.0.0.1:3000. This static server serves the built `data.json` and has no scan endpoint. Re-export and rebuild to update the snapshot. The JSON can contain private project names and usage; review it before sharing the built site.

## Pages

| Route | What it shows |
|-------|---------------|
| `/` | Today (live), this week, this month and all-time cost and tokens; daily usage (30/90/180 days or all time, weekly bars past 180 days); today as a 24-hour dial, bars or table; providers; top models and projects; live daemon sessions |
| `/projects`, `/projects/:name` | Sortable, filterable project table; per-project daily usage, token composition, providers and models |
| `/models` | Cost and token buckets per model, a sortable table of every model, provider totals |
| `/timeline` | Daily usage, a one-year calendar heatmap, monthly sums, and the full daily ledger |
| `/3d-view` | Day × project or day × hour bar field (three.js, loaded only with WebGL), plus the same values as a 2D grid |

Sealed days carry a lock badge; today is marked live. Every chart has a table
view. Costs are estimates and are labelled as such. A Motion setting (System /
On / Off) next to the theme toggle controls the animated header, count-ups and
transitions; System follows the OS reduced-motion setting.

## License

AGPL-3.0-only — [license text](../../LICENSE). See [licenses and source](../../docs/licensing.md).
