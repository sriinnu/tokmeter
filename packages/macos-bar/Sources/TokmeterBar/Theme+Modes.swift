// Theme+Modes.swift — BackgroundMode / HeroMode / CardMode / ThemeFonts.
//
// Lifted out of Theme.swift to keep that file under the LOC budget. These
// enums are pure visual mode descriptors; AppTheme picks one of each via
// its computed properties.

import AppKit
import SwiftUI

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
    case auroraDrift      // Deep night with slow-drifting northern-lights gradient
    case blueprintGrid    // Cream-paper bg with cyan grid lines (Blueprint)
    case noiseYellow      // Canary-yellow flat surface (Noise / neobrutalist)
    case mintPeach        // Warm peach surface (Mint / soft editorial)

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
            // Near-black with a faint warm tint to anchor the amber palette.
            return Color(red: 0.05, green: 0.035, blue: 0.020)
        case .terminalBlack:
            return Color(red: 0.0, green: 0.02, blue: 0.01)
        case .paperWarm:
            return Color(red: 0.962, green: 0.943, blue: 0.904)
        case .glassBlur:
            return Color(red: 0.18, green: 0.20, blue: 0.26).opacity(0.35)
        case .auroraDrift:
            return Color(red: 0.02, green: 0.03, blue: 0.08)
        case .blueprintGrid:
            return Color(red: 0.955, green: 0.945, blue: 0.910)
        case .noiseYellow:
            return Color(red: 1.000, green: 0.851, blue: 0.239) // #ffd93d
        case .mintPeach:
            return Color(red: 1.000, green: 0.898, blue: 0.769) // #ffe5c4
        }
    }

    /// Whether this surface is light (drives text color inversion).
    var isLight: Bool {
        switch self {
        case .lightCream, .paperWarm, .blueprintGrid, .noiseYellow, .mintPeach: return true
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
            return [base, Color(red: 0.02, green: 0.015, blue: 0.008)]
        case .lightCream:
            return [base, Color(red: 0.96, green: 0.93, blue: 0.90)]
        case .terminalBlack:
            return [Color.black, Color(red: 0.01, green: 0.03, blue: 0.01)]
        case .paperWarm:
            return [base, Color(red: 0.948, green: 0.926, blue: 0.885)]
        case .glassBlur:
            return [base, base.opacity(0.55)]
        case .auroraDrift:
            return [base, Color(red: 0.01, green: 0.02, blue: 0.05)]
        case .blueprintGrid:
            return [base, Color(red: 0.942, green: 0.928, blue: 0.890)]
        case .noiseYellow:
            return [base, base]
        case .mintPeach:
            return [base, Color(red: 0.988, green: 0.886, blue: 0.757)]
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
    case auroraDrift        // Slow-drifting aurora gradient — motion as identity
    case blueprintTechnical // Hairline cyan frame, mono digits, drafting feel
    case noiseBrutal        // Heavy black sans on canary yellow, brutalist
    case mintEditorial      // Peach surface, lime accent, hairline underline
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
    case auroraGlass      // Aurora: thin-material on the drifting bg, soft glow
    case blueprintFrame   // Blueprint: cyan hairline frame, no fill, mono
    case noiseStuck       // Noise: solid color + 2pt black border + hard offset shadow
    case mintHairline     // Mint: peach fill + 0.5pt black hairline, no shadow

    /// Corner radius — HUD/Terminal go sharper for readout feel.
    var cornerRadius: CGFloat {
        switch self {
        case .hudPanel, .terminalPanel, .blueprintFrame: return 4
        case .paperHairline: return 2
        case .neonOutlined: return 10
        case .glassFrost, .auroraGlass: return 14
        case .noiseStuck: return 8
        case .mintHairline: return 14
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
