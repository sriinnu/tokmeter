<p align="center">
  <img src="../../logo.svg" alt="tokmeter" width="80" />
</p>

<h1 align="center">@tokmeter/tui</h1>

<p align="center"><strong>Interactive terminal UI with charts, sparklines, and heatmaps</strong></p>

---

A full-screen terminal dashboard for exploring token usage. Built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs).

## Install

```bash
npx @tokmeter/tui
```

## Views

| View | Key | Description |
|------|-----|-------------|
| Overview | `1` | Bar charts, sparklines, provider breakdown |
| Models | `2` | Sortable table with inline charts |
| Daily | `3` | Sparkline + contribution heatmap |
| Stats | `4` | Streaks, averages, activity calendar |

## Key Bindings

| Key | Action |
|-----|--------|
| `1-4` | Switch views |
| `Tab` / arrow keys | Navigate |
| `q` / `Ctrl+C` | Quit |

## License

MIT
