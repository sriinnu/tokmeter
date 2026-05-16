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
    case aurora
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
    static var allCases: [AppTheme] = [
        .terminal, .paper, .nebula, .aurora,
        .noise, .nocturne, .glass,
    ]

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
        case .aurora:    return "Aurora"
        case .blueprint: return "Blueprint"
        case .noise:     return "Noise"
        case .mint:      return "Mint"
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
        case .aurora:    return "Northern lights, drifting"
        case .blueprint: return "Drafting paper, cyan grid"
        case .noise:     return "Neobrutalist canary yellow"
        case .mint:      return "Warm peach + lime accent"
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
        case .aurora:    return "sparkle"
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
        case .aurora:
            // Soft rounded — the bg is doing the heavy visual lifting
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
