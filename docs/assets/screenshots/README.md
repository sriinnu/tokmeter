# Screenshot capture guide

Visual assets for the main `README.md` gallery and per-surface sections.

## File names (don't rename — README references these literally)

| File | Surface | What to show | Status |
|------|---------|--------------|--------|
| `cli-overview.png` | CLI | `tokmeter` top-level table with 4+ projects, mixed providers | ☐ |
| `cli-digest.png` | CLI | `tokmeter digest --period week` — full report card | ☐ |
| `tui-overview.png` | TUI | View `1` — bar charts + sparklines + provider breakdown | ☐ |
| `tui-models.png` | TUI | View `2` — sortable model table with inline charts | ☐ |
| `tui-daily.png` | TUI | View `3` — sparkline + heatmap | ☐ |
| `tui-stats.png` | TUI | View `4` — streaks + contribution calendar | ☐ |
| `web-overview.png` | Web | Full dashboard, ideally with the green "Live" pill (daemon running) | ☐ |
| `web-3d.png` | Web | 3D timeline view (optional — only if you want to highlight it) | ☐ |
| `bar-popover.png` | macOS bar | Menubar dropdown with signals ribbon visible | ✅ |
| `bar-hub.png` | macOS bar | Hub window — projects drilldown panel | ☐ |
| `statusline.png` | Claude Code | The rainbow-infinity statusline rendered inside Claude Code | ☐ |

## Capture conventions

- **Format:** PNG, 2x retina (export at native macOS resolution).
- **Theme:** Dark mode for TUI / web / bar so the gallery reads consistent. CLI shots can be light or dark — pick one and stick with it.
- **Window size:** TUI/CLI ≈ 120×40 columns. Web 1440×900. Bar popover at its natural size (don't resize).
- **Data:** Real data is fine. If you want to redact, replace project names with generic placeholders before shooting; never blur after-the-fact.
- **Compression:** `pngquant --quality=80-92 *.png` after capture to keep the repo lean.

## Where they land

After dropping files here, update `README.md`:

1. Replace the `_coming soon_` rows in the Gallery table with `<img src="docs/assets/screenshots/<file>.png" width="640" />`.
2. Drop inline references inside the relevant surface sections (CLI, TUI, Web, macOS Menu Bar) so a reader scrolling sees each shot in context.

## What we deliberately don't include

- No "before/after" comparison shots.
- No animated GIFs of the live TUI — they're heavy and date quickly.
- No screenshots of any other tool for comparison.
