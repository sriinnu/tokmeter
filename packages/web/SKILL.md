# @sriinnu/tokmeter-web

Private workspace package, also bundled with the macOS app. In app Settings, Open web dashboard starts its local server; Stop web dashboard or quitting the app stops it. The app mode forwards read-only summary requests to the usage daemon and ships no usage export.

React web dashboard for token and cost data: Tailwind CSS v4 with
shadcn/ui-style components, Recharts for 2D charts and three.js for the 3D
view. Numbers come straight from the summary payload; sealed days are marked
apart from today's live numbers, and every chart has a table view.

## Capabilities

- Overview: today (live), week-to-date, month-to-date and all-time tiles,
  daily usage (30 / 90 / 180 days or all time, weekly bars past 180 days),
  today as a 24-hour dial with a typical-day ring, providers, top models and
  projects, live sessions
- Projects, Models and Timeline pages with sortable, filterable tables, a
  calendar heatmap and the full daily ledger
- 3D view: a day × project or day × hour bar field, loaded only with WebGL,
  with the same values always shown as a 2D grid
- Light and dark themes, and a Motion setting (System / On / Off)

## Setup

```bash
# From the repository root
bun install
bun run dev:web
```

Development and Vite preview read `/api/summary`, which scans local usage. `/data.json` is a fallback, not an override for the live endpoint. See the [README](README.md#data) for exporting and previewing a static snapshot.

## License

AGPL-3.0-only; see [licenses and source](../../docs/licensing.md).
