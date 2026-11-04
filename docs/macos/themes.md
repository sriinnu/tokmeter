# Menu bar and themes

TokmeterBar shows today's tokens in the menu bar. Click it for today's cost,
models and projects. It reads everything from the local daemon, which it starts
when needed, and updates itself through Sparkle. It needs Node.js 22+ with npx for
that daemon.

## The model list

**Today** and **All** switch between today and all time.

- **Today** shows the five costliest models, then the top model of every other
  provider you used, free or not, then up to three more $0 models, busiest first.
- **All** shows the top five by cost.
- **Show all** lists everything. Hovering a row shows its full model id, tokens,
  exact cost and token mix.
- The line under a name appears when it's needed: the route for a `model@route`
  id, or the provider when two rows would otherwise look the same.

The column on the right reads:

| It shows | It means |
| --- | --- |
| `$8,698.60` | Dollars and cents, up to $9,999.99 |
| `$25,748` | From $10,000, without cents |
| `$1.25M`, `$3.46B` | From a million. Hover for every cent |
| `free` | A free model, with its tokens on the line under its name |
| `—` or `n/a` | No price known. It doesn't mean free |

These are estimates at API rates, or the tool's own figure where it reports one.
They aren't your bill. See [How the numbers work](../how-the-numbers-work.md).

Rows carry the logo of the agent that ran them. Agents without a logo get a letter
mark. Paper and the five instrument themes draw no icons in this list.

## Projects

Each project shows its tokens and cost. A project used by two or more agents also
shows a bar and a line such as `Claude Code $3.1K · Codex $1.3K`. An agent with
no dollars shows its tokens instead. Click a project to see which agent used which
model. The same model under two agents stays two rows, because they can bill
differently.

## Rates

The **$/M** button in the models header opens each model's rates and where they
came from. It also warns when a price is held back, disputed by its sources, or
rests on one source. [How the numbers work](../how-the-numbers-work.md) explains
those holds and what they don't catch.

## Themes

Eleven themes change how it looks, not what it counts: Terminal, Paper, Prism,
Lagoon, Carbon, Glass, and five instruments (Meter, Pump, Rams, Deck, Passbook).
Pick one in Settings.

The logos come from [lobe-icons](https://github.com/lobehub/lobe-icons) (MIT). The
**Licenses** button in the footer opens the notice, and the marks stay with their
owners.

## For contributors: native theme development

The popup and Hub share `AppTheme`, palettes, typography, and surface renderers. Themes change presentation; telemetry, cost provenance, refresh, and navigation remain in their existing models and views.

## Files and ownership

Paths below are relative to `packages/macos-bar/Sources/TokmeterBar/`.

| File | Responsibility |
| --- | --- |
| `Theme.swift` | Persisted identity, picker names/order, mode selection, typography, semantic status and monetary ink |
| `ThemePalettes.swift` | Six palette roles for each theme |
| `Theme+Modes.swift` | Background, header, card, and font descriptors |
| `HeroBackground.swift` | Dispatch from a header mode to its renderer |
| `CardBackground.swift` | Popup card dispatch |
| `HubCard.swift` | Hub content spacing and shared panel dispatch |
| `PrismSurface.swift` | Stateless `PrismPanel` and `PrismHeroBackdrop`; the panel is reused by popup and Hub |
| `FrostedGlass.swift` | Glass material, opacity, and accessibility fallbacks |
| `Skins.swift`, `SkinFooter.swift` | Hook points and dispatch for skin themes: hero, signals, ledger, section head, model/project rows, card, chart, tabs, disclosure, footnote, footer |
| `Skin+<Name>.swift`, `Skin+<Name>Footer.swift` | One skin's palette, surface, type, and hook views |

`PrismPanel` accepts palette colors and a corner radius. `PrismHeroBackdrop` accepts palette colors and draws facets relative to the available size. Neither reads settings, loads telemetry, starts timers, or owns interaction state.

Use the existing wrappers when adding a surface. Do not copy a complete card or dashboard to introduce a theme. Keep a distinctive surface renderer in its own file when it is shared or would enlarge a dispatch view substantially.

## Saved identifiers

In 1.14.1 the picker has six entries. Three styles were replaced while retaining their stored identifiers:

| Display name | Stored value |
| --- | --- |
| Terminal | `terminal` |
| Paper | `paper` |
| Prism | `nebula` |
| Lagoon | `aurora` |
| Carbon | `nocturne` |
| Glass | `glass` |

1.15.0 added five skin themes, listed after Paper in the picker: Meter (`meter`), Pump (`pump`), Rams (`rams`), Deck (`deck`), and Passbook (`passbook`). A skin lives in its own files and plugs into the hooks in `Skins.swift`; it never edits shared views.

The stored value is the enum raw value used by `@AppStorage("appTheme")`. Legacy mode names also remain in source. Renaming a display label does not require changing stored values. Hidden enum cases remain decodable but are omitted from the explicitly curated `AppTheme.allCases` picker list.

## Add or revise a theme

1. Choose whether this is a new persisted theme or a replacement for an existing style. For a new theme, add a unique enum case and deliberately add it to the picker list; for a replacement, retain its raw value.
2. Define its six palette roles, display label, icon, typography, and background/header/card modes. Reuse an existing mode when its rendering is sufficient.
3. Put custom drawing in a small view with explicit inputs. Connect it through the popup and Hub wrappers. Avoid theme-specific copies of data views.
4. Set text and monetary/status ink for the selected theme's surface, independently of the host macOS appearance. Use named semantic status colors for warnings, success, and danger. Check long values, unavailable values, and tooltip legibility.
5. Update the theme table and macOS README. State whether the result is source-only, locally installed, or released.

## Verify

From the repository root, render synthetic fixtures and run the focused native checks:

```sh
mkdir -p /tmp/tokmeter-theme-review
TOKMETER_UI_QA_DIR=/tmp/tokmeter-theme-review \
swift test --package-path packages/macos-bar \
  --filter 'DemoRenderTests/testRenderThemeReview|HubResponsiveLayoutTests|ThemeContrastTests|PopoverLayoutTests'
```

The demo renderer uses the picker list. The production Hub/layout/contrast tests have explicit theme lists; add a genuinely new theme there too. Current Hub captures cover widths of 860, 1100, and 1500 points. File names use stored identifiers, so Prism images have the `nebula` prefix.

Inspect the generated popup, expanded details, tooltip, and Hub images. Check header and value clipping, chart contrast, panel edges, and large-window spacing. Contrast tests compare semantic ink and native widget pixels; their reference swatches use the same AppKit capture path as the widgets to avoid cross-profile comparisons.

These checks use fixtures. They do not establish live pointer/VoiceOver acceptance, sustained performance, or release readiness. Keep those results separate in the [completion tracker](../macos-completion.md).
