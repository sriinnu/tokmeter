# Tokmeter

Tokmeter parses local AI coding-agent session files and aggregates token usage and cost by project, model, provider, and day. It provides a CLI, TypeScript API, terminal UI, web workspace, MCP server, local daemon, and macOS app.

Claude Code and Codex are the primary validation targets. See [provider compatibility](docs/compatibility.md) for the other parsers and their known limits.

## Requirements and installation

The npm packages require Node.js 18+. Reading Claude Code and Codex session files does not require provider credentials. Pricing lookups can fetch public catalog data; `--light` skips them.

```sh
# Run a report without a global install
npx @sriinnu/tokmeter --today
npx @sriinnu/tokmeter --today --light

# Install the CLI and local daemon/MCP server
npm install -g @sriinnu/tokmeter @sriinnu/drishti
```

Two packages are published:

| Package | Contents |
| --- | --- |
| [`@sriinnu/tokmeter`](packages/tokmeter/README.md) | Core API, CLI, and terminal UI |
| [`@sriinnu/drishti`](packages/mcp/README.md) | MCP server, daemon, statusline, and live terminal UI |

`packages/core`, `packages/cli`, and `packages/tui` are private workspace packages bundled into `@sriinnu/tokmeter`. `packages/web` is a separate private workspace app run from source.

## CLI usage

```sh
tokmeter --today
tokmeter models --project my-app --json
tokmeter daily --week
tokmeter projects
tokmeter stats --month
tokmeter digest --period week
tokmeter pricing sonnet
```

Filters include `--project`, `--claude`, `--codex`, `--week`, `--month`, and `--since YYYY-MM-DD --until YYYY-MM-DD`. Use `--json` for machine-readable output and `--light` for token-only reports.

Project naming and backup operations have separate guides:

- [Aliases](docs/aliases.md): merge display names, tag projects, or hide them from lists.
- [Backup and restore](docs/backup-restore.md): create portable snapshots, preview cleanup, and restore backups. Cleanup deletes source files; keep the confirmation and backup steps.
- [CLI reference](packages/cli/README.md): commands and examples.

## TypeScript API

The root export provides the core API. Convenience query helpers use the `/cli` subpath.

```ts
import { TokmeterCore } from "@sriinnu/tokmeter";
import { loadTokmeterSummary } from "@sriinnu/tokmeter/cli";

const core = new TokmeterCore();
await core.scan({ providers: ["codex", "claude-code"], today: true });
const models = core.getModelCosts();
const daily = core.getDailyBreakdown();

const summary = await loadTokmeterSummary({ week: true, light: true });
```

Reuse one core scan when querying several breakdowns. See [integration guidance](docs/consuming-tokmeter.md), [core API usage](packages/core/README.md), and [SKILL.md](SKILL.md) for agent-facing integration instructions.

## Daemon, MCP, and statusline

```sh
drishti daemon start
drishti daemon status
drishti serve             # MCP server over stdio
drishti statusline        # one statusline tick
drishti live              # live terminal UI
```

The daemon uses local HTTP port `9877` for queries and WebSocket port `9876` for live registration. The macOS app, statusline, and MCP server consume its shared state. Daemon commands belong to `@sriinnu/drishti`; install it for these surfaces.

MCP tools use the `drishti_` prefix. They include usage queries, comparisons, forecasts, export, and confirmed cleanup/restore operations. See the [Drishti reference](packages/mcp/README.md) for names, configuration, and programmatic exports.

`drishti editors` lists installer targets. `drishti install-mcp` and `drishti install-statusline` write editor configuration; inspect the generated settings for your editor. See [architecture](docs/architecture.md) for registration, authentication, refresh, storage, and daemon lifecycle details.

## Terminal and web interfaces

```sh
# After installing @sriinnu/tokmeter
tokmeter-tui

# Without a global install
npx -p @sriinnu/tokmeter tokmeter-tui
```

The terminal UI supports overview, model, daily, and statistics views. See its [keys and commands](packages/tui/README.md).

Run the web workspace from a source checkout:

```sh
bun install
bun run dev:web
```

Open `http://localhost:3000`. See [web setup and data sources](packages/web/README.md).

## macOS app

Release builds target Apple silicon and macOS 14+. Node.js 18+ with npx is also required for the local daemon.

For published 1.10.0, install `@sriinnu/drishti`, run `drishti daemon start`, and open TokmeterBar from `/Applications`. Download the app from [GitHub Releases](https://github.com/sriinnu/tokmeter/releases). The current source improves automatic startup by resolving paired Node/npx and invoking version-matched Drishti, with prerequisite and retry controls on failure.

The popup gives today's tokens and estimated API cost equal prominence, with models and projects below. Chart hover cards show exact daily tokens and cost. **Usage details** expands lifetime totals, trends, and signals; the view scrolls when it exceeds the available height. Six themes are selectable: Terminal, Paper, Prism, Lagoon, Carbon, and Glass. Glass uses native light frost and explicit theme-based text/status colors. The Hub provides larger breakdowns and settings. Settings → **Open web dashboard** starts its local server on demand; **Stop web dashboard** or quitting the app stops it.

See [macOS build and runtime details](packages/macos-bar/README.md), [first-use checks](docs/macos/first-use.md), and [popover validation](docs/macos/popover-usability.md). The [completion tracker](docs/macos-completion.md) records remaining fresh-machine, reliability, update, accounting, accessibility, and trial gates.

The [synthetic walkthrough](docs/assets/demo/README.md) documents how the 1.10.0 example images were generated; it is not a capture of the current local candidate.

## Accounting and limitations

- Estimated API cost applies model rates to recorded usage. It is not a subscription bill.
- Tool-reported cost comes from local telemetry and has not been independently reconciled to an invoice.
- Missing prices or usage fields remain unavailable; missing price does not mean zero cost.
- Earlier saved days can lack provenance needed to separate estimates from tool reports. Ordinary refreshes preserve those aggregates.
- Sealed daily aggregates retain totals after raw logs are removed. They do not preserve every transcript or per-request detail.

See [how the numbers work](docs/how-the-numbers-work.md) for token buckets, pricing sources, and reconciliation examples. Performance and integration coverage depend on local history and provider formats; the [validation record](docs/release/validation.md) states what was checked.

## Development

```sh
git clone https://github.com/sriinnu/tokmeter.git
cd tokmeter
bun install
bun run build
bun run lint
bun run test
```

Useful workspace commands:

| Command | Purpose |
| --- | --- |
| `bun run cli` | CLI from source |
| `bun run tui` | Terminal UI from source |
| `bun run dev:web` | Web development server |
| `bun run drishti:serve` | MCP server from source |
| `bun run daemon:start` | Start the source daemon |
| `bun run daemon:status` | Check daemon status |
| `bun run daemon:stop` | Stop the daemon |
| `bun run bar:build` | Build an ad-hoc macOS bundle without installing |
| `bun run bar` | Build, install, and launch the macOS app |

Native tests require macOS and Xcode:

```sh
swift test --package-path packages/macos-bar
```

Optional UI fixtures use `TOKMETER_UI_QA_DIR`; the walkthrough renderer uses `TOKMETER_DEMO_DIR`. Create the output directory before running. The JavaScript suite and native suite are separate; neither replaces live accessibility or sustained runtime checks.

## Packaging and release

```sh
# After bun run build: prepare local npm tarballs without publishing
bash scripts/prepare-packages.sh /tmp/tokmeter-candidate
bun run check:secrets
```

Native release scripts support Developer ID signing, notarization, stapling, Sparkle metadata, and ZIP packaging. `bun run bar:signed` and `bun run bar:release` require configured distribution credentials; publishing is a separate action. Follow the [native release pipeline](packages/macos-bar/RELEASE.md) and [release validation](docs/release/validation.md).

## License

- Applications: [AGPL-3.0-only](LICENSE).
- Core source under `packages/core`: [MPL-2.0](packages/core/LICENSE), including when bundled into an application.

Release artifacts include license texts and a source snapshot. The macOS bundle also includes Sparkle notices. See [licenses and source](docs/licensing.md) for artifact contents and rebuild instructions.

Copyright (c) 2026 Srinivas Pendela and contributors.
