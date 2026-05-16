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
            // Purple → magenta → orange. Classic TOKMETER identity.
            return ThemeColors(
                primary:   Color(red: 0.295, green: 0.175, blue: 0.705),  // #4b2cb4 deep purple
                secondary: Color(red: 0.568, green: 0.259, blue: 0.890),  // #9142e3 electric violet
                accent:    Color(red: 0.710, green: 0.408, blue: 0.980),  // #b568fa soft violet
                highlight: Color(red: 0.984, green: 0.600, blue: 0.180),  // #fb992e amber
                warm:      Color(red: 0.992, green: 0.420, blue: 0.322),  // #fd6b52 warm orange
                tertiary:  Color(red: 0.098, green: 0.816, blue: 0.675)   // #19d0ac teal
            )

        case .nocturne:
            // Deep indigo, calm lavenders, sparkline-friendly. No loud colors.
            return ThemeColors(
                primary:   Color(red: 0.102, green: 0.122, blue: 0.212),  // #1a1f36 midnight
                secondary: Color(red: 0.498, green: 0.525, blue: 0.678),  // #7f86ad soft lavender
                accent:    Color(red: 0.376, green: 0.647, blue: 0.980),  // #60a5fa electric blue
                highlight: Color(red: 0.957, green: 0.894, blue: 0.757),  // #f4e4c1 cream highlight
                warm:      Color(red: 0.878, green: 0.478, blue: 0.371),  // #e07a5f muted coral
                tertiary:  Color(red: 0.529, green: 0.659, blue: 0.471)   // #87a878 sage
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
            // Cool neutral palette — slate, ice, sage. Reads as "Apple frost".
            return ThemeColors(
                primary:   Color(red: 0.420, green: 0.486, blue: 0.710),  // #6b7cb5 slate blue
                secondary: Color(red: 0.596, green: 0.659, blue: 0.820),  // #98a8d1 ice blue
                accent:    Color(red: 0.490, green: 0.765, blue: 0.910),  // #7dc3e8 bright ice
                highlight: Color(red: 0.780, green: 0.647, blue: 0.537),  // #c7a589 warm beige
                warm:      Color(red: 0.710, green: 0.643, blue: 0.757),  // #b5a4c1 lavender-slate
                tertiary:  Color(red: 0.627, green: 0.773, blue: 0.706)   // #a0c5b4 sage
            )

        case .aurora:
            // Northern-lights palette — deep teal, electric green, soft violet,
            // with a warm coral highlight so the cost number doesn't melt into
            // the cool background.
            return ThemeColors(
                primary:   Color(red: 0.055, green: 0.255, blue: 0.353),  // #0e4159 deep teal
                secondary: Color(red: 0.180, green: 0.792, blue: 0.694),  // #2ecaa3 aurora green
                accent:    Color(red: 0.541, green: 0.482, blue: 0.945),  // #8a7af1 electric violet
                highlight: Color(red: 0.984, green: 0.722, blue: 0.420),  // #fbb86b warm coral
                warm:      Color(red: 0.961, green: 0.553, blue: 0.420),  // #f58d6b sunset coral
                tertiary:  Color(red: 0.412, green: 0.871, blue: 0.847)   // #69ded8 light teal
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
