// Theme.swift — complete theme system for the menubar popover.
//
// Each theme is a full visual language, not just a palette. It defines:
//   - six semantic color roles (primary/secondary/accent/highlight/warm/tertiary)
//   - a background surface mode (dark, light cream, deep indigo, etc)
//   - a hero header mode (gradient, calm, horizon, scanlines)
//   - a card rendering mode (glossy, flat, paper, neon-outlined, HUD panel)
//   - a typography hint (monospaced hero for HUD, rounded for the rest)
//
// Switching a theme re-dresses every surface without changing any view logic.
// The user picks a theme in Settings; persisted via @AppStorage("appTheme").
//
// Themes:
//   • Nebula    — purple→magenta→orange gradient, glossy dark cards (default)
//   • Nocturne  — deep indigo, calm, no gradient, sparkline-friendly
//   • Daylight  — cream/ivory light theme for light-mode Mac users
//   • Synthwave — retrofuture horizon sun + grid + neon-outlined cards
//   • HUD       — tactical sci-fi with mono typography and status overlays
//   • Terminal  — pure CRT: black phosphor-green mono, scanlines, cursor
//   • Paper     — editorial: warm cream, serif display numbers, hairlines
//   • Glass     — translucent material panels + cool-neutral accents

import SwiftUI

// MARK: - Color roles

/// Six semantic color roles used everywhere in the UI. Each theme provides
/// its own values so changing themes re-tints the entire popover.
struct ThemeColors {
    let primary: Color      // Hero gradient start, dominant tone
    let secondary: Color    // Hero gradient middle, primary data emphasis
    let accent: Color       // Bright accent, chart lines, links
    let highlight: Color    // Monetary/cost color (amber/gold family)
    let warm: Color         // Gradient end, bar fill, sparkline area
    let tertiary: Color     // Streak / third stat card
}

// MARK: - Semantic status colors

/// Status-tier colors shared across every theme. These encode meaning, not
/// brand — red is "this needs your attention", amber is "approaching a
/// limit", green is "things are working." Theme-tinted palettes still pick
/// these for status signals; a future high-contrast/accessibility theme can
/// promote them to ThemeColors if it needs to override.
///
/// Centralized here because they used to live as RGB triples in 5+ files
/// (SignalsRibbon, HubPulseCard, AnomalyDetail, StatCards…). One source of
/// truth means tuning the red once tunes it everywhere.
extension Color {
    /// Red — kosha anomaly direction, late billing window, overspend pace.
    static let tokDanger = Color(red: 0.96, green: 0.42, blue: 0.42)
    /// Amber — approaching a limit (cache <60%, billing >75% elapsed, etc).
    static let tokWarning = Color(red: 0.95, green: 0.70, blue: 0.30)
    /// Green — healthy (cache ≥90%, anomaly going down, low burn).
    static let tokSuccess = Color(red: 0.13, green: 0.80, blue: 0.47)
}

// MARK: - Background surface

/// How the whole popover surface paints itself.
enum BackgroundMode {
    case dark             // Standard macOS dark background
    case darkGradient     // Subtle top→bottom dark gradient
    case deepIndigo       // Near-black with cool blue tint (Nocturne)
    case lightCream       // Light ivory/cream (Daylight)
    case deepMagenta      // Very dark purple base (Synthwave)
    case tactical         // Very dark with green-black tint (HUD)
    case terminalBlack    // True black (Terminal)
    case paperWarm        // Warm off-white editorial (Paper)
    case glassBlur        // Translucent material — works over wallpaper (Glass)

    /// The base surface color painted as the popover's background.
    var surfaceColor: Color {
        switch self {
        case .dark, .darkGradient:
            return Color(NSColor.windowBackgroundColor)
        case .deepIndigo:
            return Color(red: 0.04, green: 0.05, blue: 0.10)
        case .lightCream:
            return Color(red: 0.975, green: 0.955, blue: 0.925)
        case .deepMagenta:
            return Color(red: 0.07, green: 0.03, blue: 0.13)
        case .tactical:
            return Color(red: 0.02, green: 0.04, blue: 0.04)
        case .terminalBlack:
            return Color(red: 0.0, green: 0.02, blue: 0.01)
        case .paperWarm:
            return Color(red: 0.962, green: 0.943, blue: 0.904)
        case .glassBlur:
            // Base tint; the actual blur is provided by a Material layer in the view.
            return Color(red: 0.18, green: 0.20, blue: 0.26).opacity(0.35)
        }
    }

    /// Whether this surface is light (drives text color inversion).
    var isLight: Bool {
        switch self {
        case .lightCream, .paperWarm: return true
        default: return false
        }
    }

    /// Whether this surface uses a translucent material layer (Glass).
    /// The view renders a regular-material background + tint instead of a solid fill.
    var usesMaterial: Bool {
        if case .glassBlur = self { return true }
        return false
    }

    /// Primary body text color appropriate for this surface.
    var primaryTextColor: Color {
        isLight ? Color.black.opacity(0.88) : Color.white.opacity(0.92)
    }

    /// Secondary/label text color.
    var secondaryTextColor: Color {
        isLight ? Color.black.opacity(0.55) : Color.white.opacity(0.55)
    }

    /// The subtle gradient pair applied to the outer background.
    func gradientColors() -> [Color] {
        let base = surfaceColor
        switch self {
        case .darkGradient:
            return [base, base.opacity(0.92)]
        case .deepIndigo:
            return [base, Color(red: 0.02, green: 0.03, blue: 0.07)]
        case .deepMagenta:
            return [base, Color(red: 0.04, green: 0.02, blue: 0.08)]
        case .tactical:
            return [base, Color(red: 0.01, green: 0.02, blue: 0.02)]
        case .lightCream:
            return [base, Color(red: 0.96, green: 0.93, blue: 0.90)]
        case .terminalBlack:
            return [Color.black, Color(red: 0.01, green: 0.03, blue: 0.01)]
        case .paperWarm:
            return [base, Color(red: 0.948, green: 0.926, blue: 0.885)]
        case .glassBlur:
            return [base, base.opacity(0.55)]
        case .dark:
            return [base, base]
        }
    }
}

// MARK: - Hero header style

/// How the giant "$48.95 / today" header renders. Branch on this in the view.
enum HeroMode {
    case nebulaGradient     // Classic purple→magenta→orange diagonal
    case nocturneCalm       // Deep indigo solid with a faint accent glow
    case daylightSoft       // Cream with soft color wave; dark foreground
    case synthwaveHorizon   // Sunset horizon + perspective grid overlay
    case hudScanlines       // Dark panel with scanline + OPERATIONAL pill
    case terminalCRT        // Pure black + dense scanlines + green phosphor + cursor
    case paperEditorial     // Cream, large serif display number, hairline rule
    case glassMaterial      // Translucent material + soft tint + glossy highlight
}

// MARK: - Card style

/// How KPI cards and list rows render — fill, border, corner radius, shadow.
enum CardMode {
    case glossyDark       // Nebula: color-tinted fill with soft glow
    case flatDark         // Nocturne: gray-tinted flat fill
    case lightPaper       // Daylight: white fill with soft shadow
    case neonOutlined     // Synthwave: neon border, minimal fill, inner glow
    case hudPanel         // HUD: rectangular, tactical, mono values
    case terminalPanel    // Terminal: black fill, green hairline border, mono
    case paperHairline    // Paper: no fill, thin black hairline border, serif
    case glassFrost       // Glass: ultra-thin material with subtle border

    /// Corner radius — HUD/Terminal go sharper for readout feel.
    var cornerRadius: CGFloat {
        switch self {
        case .hudPanel, .terminalPanel: return 4
        case .paperHairline: return 2
        case .neonOutlined: return 10
        case .glassFrost: return 14
        default: return 12
        }
    }
}

// MARK: - Per-theme typography

/// Font personality for a theme. Each role (hero number, stat value, label,
/// body) can pick its own design so Paper can use serif, Terminal can use
/// monospaced, Synthwave can use display, etc.
struct ThemeFonts {
    let heroDesign: Font.Design
    let heroWeight: Font.Weight
    let valueDesign: Font.Design
    let valueWeight: Font.Weight
    let labelDesign: Font.Design
    let bodyDesign: Font.Design

    func hero(size: CGFloat) -> Font {
        Font.system(size: size, weight: heroWeight, design: heroDesign)
    }
    func value(size: CGFloat) -> Font {
        Font.system(size: size, weight: valueWeight, design: valueDesign)
    }
    func label(size: CGFloat, weight: Font.Weight = .medium) -> Font {
        Font.system(size: size, weight: weight, design: labelDesign)
    }
    func body(size: CGFloat, weight: Font.Weight = .regular) -> Font {
        Font.system(size: size, weight: weight, design: bodyDesign)
    }
}

// MARK: - Theme enum

enum AppTheme: String, CaseIterable, Identifiable {
    case nebula
    case nocturne
    case daylight
    case synthwave
    case hud
    case terminal
    case paper
    case glass

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .nebula:    return "Nebula"
        case .nocturne:  return "Nocturne"
        case .daylight:  return "Daylight"
        case .synthwave: return "Synthwave"
        case .hud:       return "HUD"
        case .terminal:  return "Terminal"
        case .paper:     return "Paper"
        case .glass:     return "Glass"
        }
    }

    var tagline: String {
        switch self {
        case .nebula:    return "Warm purple identity"
        case .nocturne:  return "Calm dark focus"
        case .daylight:  return "Cream daytime view"
        case .synthwave: return "Retrofuture neon"
        case .hud:       return "Tactical panel"
        case .terminal:  return "CRT phosphor retro"
        case .paper:     return "Editorial serif"
        case .glass:     return "Translucent glass"
        }
    }

    var icon: String {
        switch self {
        case .nebula:    return "sparkles"
        case .nocturne:  return "moon.stars.fill"
        case .daylight:  return "sun.max.fill"
        case .synthwave: return "sunrise.fill"
        case .hud:       return "scope"
        case .terminal:  return "terminal.fill"
        case .paper:     return "doc.text.fill"
        case .glass:     return "circle.lefthalf.filled"
        }
    }

    /// Convenience: whether the hero uses monospaced digits (HUD + Terminal).
    /// Kept so the view has a quick readability signal.
    var monoHero: Bool {
        switch self {
        case .hud, .terminal: return true
        default: return false
        }
    }

    var backgroundMode: BackgroundMode {
        switch self {
        case .nebula:    return .darkGradient
        case .nocturne:  return .deepIndigo
        case .daylight:  return .lightCream
        case .synthwave: return .deepMagenta
        case .hud:       return .tactical
        case .terminal:  return .terminalBlack
        case .paper:     return .paperWarm
        case .glass:     return .glassBlur
        }
    }

    var heroMode: HeroMode {
        switch self {
        case .nebula:    return .nebulaGradient
        case .nocturne:  return .nocturneCalm
        case .daylight:  return .daylightSoft
        case .synthwave: return .synthwaveHorizon
        case .hud:       return .hudScanlines
        case .terminal:  return .terminalCRT
        case .paper:     return .paperEditorial
        case .glass:     return .glassMaterial
        }
    }

    var cardMode: CardMode {
        switch self {
        case .nebula:    return .glossyDark
        case .nocturne:  return .flatDark
        case .daylight:  return .lightPaper
        case .synthwave: return .neonOutlined
        case .hud:       return .hudPanel
        case .terminal:  return .terminalPanel
        case .paper:     return .paperHairline
        case .glass:     return .glassFrost
        }
    }

    /// Type personality for each role. The view reads this to pick fonts.
    var fonts: ThemeFonts {
        switch self {
        case .nebula:
            return ThemeFonts(heroDesign: .rounded,    heroWeight: .bold,
                              valueDesign: .rounded,   valueWeight: .bold,
                              labelDesign: .rounded,   bodyDesign: .rounded)
        case .nocturne:
            return ThemeFonts(heroDesign: .rounded,    heroWeight: .semibold,
                              valueDesign: .rounded,   valueWeight: .semibold,
                              labelDesign: .rounded,   bodyDesign: .rounded)
        case .daylight:
            return ThemeFonts(heroDesign: .default,    heroWeight: .bold,
                              valueDesign: .default,   valueWeight: .bold,
                              labelDesign: .default,   bodyDesign: .default)
        case .synthwave:
            // SF default with heavy weight reads "digital display" better than rounded
            return ThemeFonts(heroDesign: .default,    heroWeight: .heavy,
                              valueDesign: .default,   valueWeight: .heavy,
                              labelDesign: .rounded,   bodyDesign: .rounded)
        case .hud:
            return ThemeFonts(heroDesign: .monospaced, heroWeight: .bold,
                              valueDesign: .monospaced, valueWeight: .bold,
                              labelDesign: .monospaced, bodyDesign: .monospaced)
        case .terminal:
            // Terminal uses regular weight mono everywhere — CRT readability, not bold
            return ThemeFonts(heroDesign: .monospaced, heroWeight: .regular,
                              valueDesign: .monospaced, valueWeight: .regular,
                              labelDesign: .monospaced, bodyDesign: .monospaced)
        case .paper:
            // Serif display numbers; clean sans for labels and body (editorial dual-font)
            return ThemeFonts(heroDesign: .serif,      heroWeight: .bold,
                              valueDesign: .serif,     valueWeight: .bold,
                              labelDesign: .default,   bodyDesign: .default)
        case .glass:
            // Light weights read as "glass" — airy, not heavy
            return ThemeFonts(heroDesign: .rounded,    heroWeight: .medium,
                              valueDesign: .rounded,   valueWeight: .semibold,
                              labelDesign: .rounded,   bodyDesign: .rounded)
        }
    }

    /// Six-role color palette per theme. Defined in ThemePalettes.swift to
    /// keep this file focused on structure + personality; the palettes are
    /// just data values that are likely to be tweaked independently.
    var colors: ThemeColors { palette }
}
