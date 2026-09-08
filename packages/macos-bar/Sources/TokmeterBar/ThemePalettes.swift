// ThemePalettes.swift — color data for the 8 themes.
//
// Separated from Theme.swift so the structural/typographic definitions stay
// compact and the palette tweaks don't churn the main theme file. Each
// palette fills the six `ThemeColors` roles:
//
//   primary    — hero gradient start, dominant tone
//   secondary  — hero gradient middle, primary data emphasis
//   accent     — chart lines, interactive highlights
//   highlight  — monetary/cost color (amber/gold family by convention)
//   warm       — gradient end, bar fill, sparkline area
//   tertiary   — streak / third stat card

import SwiftUI

extension AppTheme {
    /// The concrete color values for this theme. Read via `theme.colors`.
    var palette: ThemeColors {
        switch self {
        case .nebula:
            // Prism: violet/cyan spectrum, pale gold for monetary values.
            return ThemeColors(
                primary:   Color(red: 0.22, green: 0.12, blue: 0.46),
                secondary: Color(red: 0.76, green: 0.66, blue: 1.00),
                accent:    Color(red: 0.43, green: 0.88, blue: 1.00),
                highlight: Color(red: 1.00, green: 0.82, blue: 0.48),
                warm:      Color(red: 0.96, green: 0.55, blue: 0.76),
                tertiary:  Color(red: 0.38, green: 0.94, blue: 0.80)
            )

        case .nocturne:
            // Carbon: neutral graphite, chalk data, copper monetary emphasis.
            return ThemeColors(
                primary:   Color(red: 0.105, green: 0.105, blue: 0.11),
                secondary: Color(red: 0.88, green: 0.89, blue: 0.90),
                accent:    Color(red: 0.83, green: 0.85, blue: 0.87),
                highlight: Color(red: 1.00, green: 0.72, blue: 0.51),
                warm:      Color(red: 0.87, green: 0.57, blue: 0.39),
                tertiary:  Color(red: 0.70, green: 0.75, blue: 0.73)
            )

        case .daylight:
            // Cream paper with pastel data. For light-mode Mac users.
            return ThemeColors(
                primary:   Color(red: 0.647, green: 0.580, blue: 0.976),  // #a594f9 muted lavender
                secondary: Color(red: 1.000, green: 0.545, blue: 0.420),  // #ff8b6b coral
                accent:    Color(red: 0.176, green: 0.831, blue: 0.749),  // #2dd4bf teal
                highlight: Color(red: 0.961, green: 0.620, blue: 0.043),  // #f59e0b warm amber
                warm:      Color(red: 0.984, green: 0.443, blue: 0.522),  // #fb7185 rose
                tertiary:  Color(red: 0.063, green: 0.725, blue: 0.506)   // #10b981 spring green
            )

        case .synthwave:
            // Hot neon sunset. Magenta, cyan, laser. Outrun aesthetic.
            return ThemeColors(
                primary:   Color(red: 1.000, green: 0.000, blue: 0.431),  // #ff006e hot magenta
                secondary: Color(red: 0.000, green: 0.961, blue: 1.000),  // #00f5ff electric cyan
                accent:    Color(red: 0.851, green: 0.275, blue: 0.937),  // #d946ef bright violet
                highlight: Color(red: 1.000, green: 0.420, blue: 0.208),  // #ff6b35 neon orange
                warm:      Color(red: 1.000, green: 0.824, blue: 0.247),  // #ffd23f sunset gold
                tertiary:  Color(red: 0.224, green: 1.000, blue: 0.078)   // #39ff14 laser green
            )

        case .hud:
            // Pivoted to amber-on-black ("old radar") so the five tier colors
            // have actual spread — the previous all-green palette collapsed
            // every tier-composition signal into a monochrome smear. Tier
            // colors now span deep-amber → bright-amber → cyan → red → teal
            // → muted-orange, mil-aesthetic intact but functionally readable.
            return ThemeColors(
                primary:   Color(red: 0.349, green: 0.180, blue: 0.000),  // #592e00 deep amber base
                secondary: Color(red: 1.000, green: 0.690, blue: 0.000),  // #ffb000 radar amber
                accent:    Color(red: 0.000, green: 0.831, blue: 1.000),  // #00d4ff signal cyan
                highlight: Color(red: 1.000, green: 0.882, blue: 0.510),  // #ffe182 readout cream
                warm:      Color(red: 1.000, green: 0.396, blue: 0.180),  // #ff652e alert orange
                tertiary:  Color(red: 0.235, green: 0.616, blue: 0.671)   // #3c9eab muted teal
            )

        case .terminal:
            // Pure CRT — phosphor green with a single amber accent for emphasis.
            // All "colors" live in the green spectrum so nothing breaks the monochrome feel.
            return ThemeColors(
                primary:   Color(red: 0.0,   green: 0.10,  blue: 0.03),   // #001a08 deep green-black
                secondary: Color(red: 0.0,   green: 1.000, blue: 0.255),  // #00ff41 phosphor green
                accent:    Color(red: 0.180, green: 1.000, blue: 0.400),  // #2eff66 lighter green
                highlight: Color(red: 1.000, green: 0.690, blue: 0.0),    // #ffb000 amber accent
                warm:      Color(red: 0.545, green: 1.000, blue: 0.325),  // #8bff53 pale green
                tertiary:  Color(red: 0.0,   green: 0.800, blue: 0.200)   // #00cc33 muted green
            )

        case .paper:
            // Editorial ink + two restrained accents (red for loss, blue for neutral).
            // Numbers rely on serif weight, not saturation, for hierarchy.
            return ThemeColors(
                primary:   Color(red: 0.102, green: 0.102, blue: 0.102),  // #1a1a1a ink
                secondary: Color(red: 0.165, green: 0.165, blue: 0.170),  // #2a2a2b near-ink
                accent:    Color(red: 0.239, green: 0.353, blue: 0.502),  // #3d5a80 editorial blue
                highlight: Color(red: 0.757, green: 0.286, blue: 0.325),  // #c14953 editorial red
                warm:      Color(red: 0.545, green: 0.435, blue: 0.278),  // #8b6f47 warm brown
                tertiary:  Color(red: 0.314, green: 0.416, blue: 0.251)   // #506a40 olive
            )

        case .glass:
            // Ink, steel, and teal on pale frosted glass.
            return ThemeColors(
                primary:   Color(red: 0.220, green: 0.380, blue: 0.550),
                secondary: Color(red: 0.300, green: 0.430, blue: 0.570),
                accent:    Color(red: 0.140, green: 0.420, blue: 0.570),
                highlight: Color(red: 0.150, green: 0.290, blue: 0.400),
                warm:      Color(red: 0.480, green: 0.530, blue: 0.670),
                tertiary:  Color(red: 0.200, green: 0.450, blue: 0.400)
            )

        case .aurora:
            // Lagoon: deep petrol with mint data and peach monetary emphasis.
            return ThemeColors(
                primary:   Color(red: 0.025, green: 0.20, blue: 0.19),
                secondary: Color(red: 0.40, green: 0.91, blue: 0.76),
                accent:    Color(red: 0.32, green: 0.82, blue: 0.79),
                highlight: Color(red: 1.00, green: 0.75, blue: 0.64),
                warm:      Color(red: 0.62, green: 0.88, blue: 0.69),
                tertiary:  Color(red: 0.77, green: 0.86, blue: 0.56)
            )

        case .blueprint:
            // Drafting-paper palette — saturated technical cyan as primary,
            // slate-grey for body, brick-red for cost (the editorial "ink"
            // accent), forest-green for healthy signals.
            return ThemeColors(
                primary:   Color(red: 0.122, green: 0.392, blue: 0.541),  // #1f648a technical blue
                secondary: Color(red: 0.286, green: 0.349, blue: 0.412),  // #495969 slate
                accent:    Color(red: 0.227, green: 0.580, blue: 0.776),  // #3a94c6 drafting cyan
                highlight: Color(red: 0.722, green: 0.290, blue: 0.275),  // #b84a46 brick red
                warm:      Color(red: 0.812, green: 0.490, blue: 0.290),  // #cf7d4a sienna
                tertiary:  Color(red: 0.298, green: 0.518, blue: 0.349)   // #4c8559 forest
            )

        case .noise:
            // Neobrutalist palette — bright flat colors, each tier gets a
            // confident hue. Black ink does the typography work; colors
            // carry the personality. NO mid-tones, NO gradients.
            return ThemeColors(
                primary:   Color(red: 0.063, green: 0.063, blue: 0.063),  // #101010 near-black ink
                secondary: Color(red: 0.388, green: 0.667, blue: 0.945),  // #63aaf1 sky blue
                accent:    Color(red: 0.929, green: 0.298, blue: 0.286),  // #ed4c49 alarm red
                highlight: Color(red: 0.231, green: 0.792, blue: 0.345),  // #3bca58 grass green
                warm:      Color(red: 0.973, green: 0.541, blue: 0.196),  // #f88a32 orange
                tertiary:  Color(red: 0.722, green: 0.529, blue: 0.957)   // #b887f4 lavender
            )

        case .mint:
            // Soft editorial palette — black ink as primary, single lime
            // accent doing the energy work. Tier roles use opacity-modulated
            // lime + black so the surface stays calm.
            return ThemeColors(
                primary:   Color(red: 0.094, green: 0.094, blue: 0.094),  // #181818 ink
                secondary: Color(red: 0.380, green: 0.380, blue: 0.380),  // #616161 grey-secondary
                accent:    Color(red: 0.357, green: 0.831, blue: 0.349),  // #5bd459 lime
                highlight: Color(red: 0.851, green: 0.337, blue: 0.235),  // #d9563c brick (cost ink)
                warm:      Color(red: 0.961, green: 0.612, blue: 0.376),  // #f59c60 peach
                tertiary:  Color(red: 0.380, green: 0.682, blue: 0.349)   // #61ae59 forest-lime
            )
        }
    }
}
