# Web dashboard

Browser dashboard for token and cost data. Built with React and Plotly.js.

## Setup

The macOS app bundles this dashboard. Choose **Open web dashboard** in its Settings to start the server, and **Stop web dashboard** to stop it. It also stops when the app quits. This mode reads the existing daemon and excludes build-machine usage exports; see [the lifecycle guide](../../docs/macos/web-dashboard.md).

For source development, this remains a private workspace package:

```bash
# From the repository root
bun install
bun run dev:web
```

Open http://localhost:3000

### Data

Both the development server and Vite preview serve `/api/summary` by scanning local session data, with a persisted-summary fallback. The browser tries this endpoint before `/data.json`, so an exported file does not override a working live endpoint.

For a static export, install Python 3, then run from the repository root:

```bash
mkdir -p packages/web/public
npx @sriinnu/tokmeter --json > packages/web/public/data.json
bun run build:web
python3 -m http.server 3000 --bind 127.0.0.1 --directory packages/web/dist
```

Open http://127.0.0.1:3000. This static server serves the built `data.json` and has no scan endpoint. Re-export and rebuild to update the snapshot. The JSON can contain private project names and usage; review it before sharing the built site.

## Charts

| Chart | Description |
|-------|-------------|
| Model cost bars | Horizontal bar chart comparing model costs |
| Provider pie | Donut chart of cost split by provider |
| Daily trend | Dual-axis line chart (tokens + cost) |
| Token breakdown | Stacked bars (input/output/cache per model) |
| Contribution heatmap | GitHub-style calendar heatmap |
| 3D surface | Isometric contribution graph |

## License

AGPL-3.0-only — [license text](../../LICENSE). See [licenses and source](../../docs/licensing.md).
