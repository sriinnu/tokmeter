<p align="center">
  <img src="../../logo.svg" alt="tokmeter" width="80" />
</p>

<h1 align="center">@sriinnu/tokmeter-web</h1>

<p align="center"><strong>React + Plotly web dashboard for token usage visualization</strong></p>

---

Rich browser-based dashboard with interactive charts. Built with React and Plotly.js.

## Setup

This is a private workspace app, run from a source checkout.

```bash
# From the repository root
bun install
bun run dev:web
```

Open http://localhost:3000

### Data

Export usage data from the CLI:

```bash
tokmeter --json > packages/web/public/data.json
```

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
