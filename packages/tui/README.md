# Terminal UI

A full-screen terminal dashboard for exploring token usage. Built with [Ink](https://github.com/vadimdemedes/ink) (React for CLIs).

## Install

This is a private workspace package. Install the public `@sriinnu/tokmeter` distribution.

```bash
npx -p @sriinnu/tokmeter tokmeter-tui
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

AGPL-3.0-only — [license text](../../LICENSE). See [licenses and source](../../docs/licensing.md).
