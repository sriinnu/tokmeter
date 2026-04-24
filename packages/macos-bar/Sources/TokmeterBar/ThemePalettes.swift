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
            // Tactical instrument panel. Phosphor green, warning amber, alert red.
            return ThemeColors(
                primary:   Color(red: 0.000, green: 0.267, blue: 0.216),  // #004437 deep tactical
                secondary: Color(red: 0.000, green: 1.000, blue: 0.553),  // #00ff8d phosphor green
                accent:    Color(red: 0.000, green: 0.831, blue: 1.000),  // #00d4ff HUD cyan
                highlight: Color(red: 1.000, green: 0.722, blue: 0.000),  // #ffb800 warning amber
                warm:      Color(red: 1.000, green: 0.549, blue: 0.000),  // #ff8c00 orange
                tertiary:  Color(red: 0.424, green: 0.859, blue: 0.533)   // #6cdb88 HUD mint
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
        }
    }
}
