# @sriinnu/tokmeter-web

Private workspace package. Run the web dashboard from this source checkout.

React + Plotly web dashboard for token usage visualization.

## Capabilities

- Interactive charts: model costs, provider pie, daily trend, token breakdown
- GitHub-style contribution heatmap
- 3D isometric surface graph
- Data import from CLI JSON export

## Setup

```bash
tokmeter --json > packages/web/public/data.json
cd packages/web && bun run dev
```

## License

AGPL-3.0-only; see [licenses and source](../../docs/licensing.md).
