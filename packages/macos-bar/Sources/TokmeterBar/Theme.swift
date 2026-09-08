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
//   • Prism     — dark glass, spectrum edges, gold monetary figures (default)
//   • Carbon    — graphite panels, copper values, monospaced figures
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

/// Resolve from the selected theme, independently of the menu window's native
/// appearance. MenuBarExtra can retain Dark Aqua while displaying light Glass.
extension AppTheme {
    /// Shared burn-rate status for the popup, Hub tile, and sidebar badge.
    func burnRateColor(_ costPerHour: Double) -> Color {
        if costPerHour >= 20 { return statusDanger }
        if costPerHour >= 10 { return statusWarning }
        return statusSuccess
    }

    var statusDanger: Color {
        backgroundMode.isLight
            ? Color(.sRGB, red: 0.35, green: 0.025, blue: 0.04)
            : Color(.sRGB, red: 0.96, green: 0.42, blue: 0.42)
    }

    var statusWarning: Color {
        backgroundMode.isLight
            ? Color(.sRGB, red: 0.29, green: 0.13, blue: 0.005)
            : Color(.sRGB, red: 0.95, green: 0.70, blue: 0.30)
    }

    var statusSuccess: Color {
        backgroundMode.isLight
            ? Color(.sRGB, red: 0.025, green: 0.205, blue: 0.10)
            : Color(.sRGB, red: 0.13, green: 0.80, blue: 0.47)
    }
}

// MARK: - Theme enum

enum AppTheme: String, CaseIterable, Identifiable {
    case nebula // Prism; retain the stored identifier for existing preferences.
    case nocturne // Carbon; keep the stored identifier for existing preferences.
    case daylight
    case synthwave
    case hud
    case terminal
    case paper
    case glass
    case aurora // Lagoon; keep the stored identifier for existing preferences.
    case blueprint
    case noise
    case mint

    /// Order the picker shows. Hidden cases stay in the enum so persisted
    /// settings don't crash on decode.
    /// - Daylight: Paper covers light better.
    /// - Blueprint: only the hero got the grid; rest was naked cream.
    /// - Mint: warmer-Paper-cousin — concept didn't differentiate enough.
    /// - HUD: even amber-rework couldn't carry it. Terminal owns the
    ///   instrument-panel space already.
    /// - Synthwave: costume that scrolling-grid couldn't save.
    /// - Noise: yellow surfaces and white cards compete with usage colors.
    static var allCases: [AppTheme] = [
        .terminal, .paper, .nebula, .aurora,
        .nocturne, .glass,
    ]

    var id: String { rawValue }

    var displayName: String {
        switch self {
        case .nebula:    return "Prism"
        case .nocturne:  return "Carbon"
        case .daylight:  return "Daylight"
        case .synthwave: return "Synthwave"
        case .hud:       return "HUD"
        case .terminal:  return "Terminal"
        case .paper:     return "Paper"
        case .glass:     return "Glass"
        case .aurora:    return "Lagoon"
        case .blueprint: return "Blueprint"
        case .noise:     return "Noise"
        case .mint:      return "Mint"
        }
    }

    var tagline: String {
        switch self {
        case .nebula:    return "Iridescent edges, dark glass"
        case .nocturne:  return "Graphite, copper, precise type"
        case .daylight:  return "Cream daytime view"
        case .synthwave: return "Retrofuture neon"
        case .hud:       return "Tactical panel"
        case .terminal:  return "CRT phosphor retro"
        case .paper:     return "Editorial serif"
        case .glass:     return "Frosted glass"
        case .aurora:    return "Deep teal and clear mint"
        case .blueprint: return "Drafting paper, cyan grid"
        case .noise:     return "Neobrutalist canary yellow"
        case .mint:      return "Warm peach + lime accent"
        }
    }

    var icon: String {
        switch self {
        case .nebula:    return "diamond.fill"
        case .nocturne:  return "square.stack.3d.up.fill"
        case .daylight:  return "sun.max.fill"
        case .synthwave: return "sunrise.fill"
        case .hud:       return "scope"
        case .terminal:  return "terminal.fill"
        case .paper:     return "doc.text.fill"
        case .glass:     return "circle.lefthalf.filled"
        case .aurora:    return "water.waves"
        case .blueprint: return "ruler.fill"
        case .noise:     return "exclamationmark.octagon.fill"
        case .mint:      return "leaf.fill"
        }
    }

    /// Convenience: whether the hero uses monospaced digits (HUD + Terminal +
    /// Blueprint). Kept so the view has a quick readability signal.
    var monoHero: Bool {
        switch self {
        case .hud, .terminal, .blueprint: return true
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
        case .aurora:    return .auroraDrift
        case .blueprint: return .blueprintGrid
        case .noise:     return .noiseYellow
        case .mint:      return .mintPeach
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
        case .aurora:    return .auroraDrift
        case .blueprint: return .blueprintTechnical
        case .noise:     return .noiseBrutal
        case .mint:      return .mintEditorial
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
        case .aurora:    return .auroraGlass
        case .blueprint: return .blueprintFrame
        case .noise:     return .noiseStuck
        case .mint:      return .mintHairline
        }
    }

    /// Opaque monetary ink with contrast on each theme's light or dark surface.
    var costInk: Color {
        if self == .nocturne { return Color(.sRGB, red: 1.0, green: 0.72, blue: 0.51) }
        if self == .aurora { return Color(.sRGB, red: 1.0, green: 0.75, blue: 0.64) }
        return backgroundMode.isLight
            ? Color(.sRGB, red: 0.29, green: 0.13, blue: 0.005)
            : Color(.sRGB, red: 1.0, green: 0.82, blue: 0.42)
    }

    /// Type personality for each role. The view reads this to pick fonts.
    var fonts: ThemeFonts {
        switch self {
        case .nebula:
            return ThemeFonts(heroDesign: .default, heroWeight: .bold,
                              valueDesign: .default, valueWeight: .bold,
                              labelDesign: .default, bodyDesign: .default)
        case .nocturne:
            return ThemeFonts(heroDesign: .monospaced, heroWeight: .semibold,
                              valueDesign: .monospaced, valueWeight: .semibold,
                              labelDesign: .default, bodyDesign: .default)
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
            return ThemeFonts(heroDesign: .default,    heroWeight: .medium,
                              valueDesign: .default,   valueWeight: .semibold,
                              labelDesign: .default,   bodyDesign: .default)
        case .aurora:
            // Lagoon: rounded values and clear body labels.
            return ThemeFonts(heroDesign: .rounded,    heroWeight: .semibold,
                              valueDesign: .rounded,   valueWeight: .semibold,
                              labelDesign: .rounded,   bodyDesign: .rounded)
        case .blueprint:
            // Mono digits + serif labels = drafting/technical-document feel
            return ThemeFonts(heroDesign: .monospaced, heroWeight: .bold,
                              valueDesign: .monospaced, valueWeight: .bold,
                              labelDesign: .serif,      bodyDesign: .default)
        case .noise:
            // Heavy black sans across the board — neobrutalist commits to
            // weight, not contrast tricks. Hero numbers hit like headlines.
            return ThemeFonts(heroDesign: .default,    heroWeight: .black,
                              valueDesign: .default,   valueWeight: .heavy,
                              labelDesign: .default,   bodyDesign: .default)
        case .mint:
            // Editorial: serif hero (display-y), default sans for labels and
            // body. Friendly, warm, considered.
            return ThemeFonts(heroDesign: .serif,      heroWeight: .semibold,
                              valueDesign: .default,   valueWeight: .semibold,
                              labelDesign: .default,   bodyDesign: .default)
        }
    }

    /// Six-role color palette per theme. Defined in ThemePalettes.swift to
    /// keep this file focused on structure + personality; the palettes are
    /// just data values that are likely to be tweaked independently.
    var colors: ThemeColors { palette }
}
