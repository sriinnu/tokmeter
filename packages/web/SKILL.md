# @sriinnu/tokmeter-web

Private workspace package, also bundled with the macOS app. In app Settings, Open web dashboard starts its local server; Stop web dashboard or quitting the app stops it. The app mode forwards read-only summary requests to the usage daemon and ships no usage export.

React + Plotly web dashboard for token usage visualization.

## Capabilities

- Interactive charts: model costs, provider pie, daily trend, token breakdown
- GitHub-style contribution heatmap
- 3D isometric surface graph
- Data import from CLI JSON export

## Setup

```bash
# From the repository root
bun install
bun run dev:web
```

Development and Vite preview read `/api/summary`, which scans local usage. `/data.json` is a fallback, not an override for the live endpoint. See the [README](README.md#data) for exporting and previewing a static snapshot.

## License

AGPL-3.0-only; see [licenses and source](../../docs/licensing.md).
