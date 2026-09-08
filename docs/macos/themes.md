# Native theme development

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

`PrismPanel` accepts palette colors and a corner radius. `PrismHeroBackdrop` accepts palette colors and draws facets relative to the available size. Neither reads settings, loads telemetry, starts timers, or owns interaction state.

Use the existing wrappers when adding a surface. Do not copy a complete card or dashboard to introduce a theme. Keep a distinctive surface renderer in its own file when it is shared or would enlarge a dispatch view substantially.

## Saved identifiers

The picker has six entries. Three styles were replaced while retaining their stored identifiers:

| Display name | Stored value |
| --- | --- |
| Terminal | `terminal` |
| Paper | `paper` |
| Prism | `nebula` |
| Lagoon | `aurora` |
| Carbon | `nocturne` |
| Glass | `glass` |

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
