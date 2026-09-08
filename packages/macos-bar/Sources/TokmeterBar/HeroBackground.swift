// HeroBackground.swift — the 8 theme-specific hero backdrops.
//
// Each variant is its own private computed view so the compiler keeps them
// type-separated (avoids ViewBuilder bloat inside a single switch). The
// outer struct dispatches based on `theme.heroMode`.
//
// Performance:
//   - Any animated layer (breathing highlight, CRT scanlines) is confined
//     to the hero — it does NOT trigger surrounding view re-renders.
//   - Path-based effects (horizon grid, corner brackets) are drawn once per
//     geometry change, not per frame.

import SwiftUI

/// Theme-dispatched hero backdrop. Drop this inside a clipped shape in the
/// HeroHeader and the right visual language appears for the active theme.
struct HeroBackground: View {
    let theme: AppTheme
    let breathToggle: Bool
    /// Whether the popover is actually on screen — see PanelVisibility.swift.
    /// Shared visibility input; ambient motion follows the parent's gated breath flag.
    var isVisible: Bool = true

    private var c: ThemeColors { theme.colors }

    var body: some View {
        switch theme.heroMode {
        case .nebulaGradient:    nebula
        case .nocturneCalm:      nocturne
        case .daylightSoft:      daylight
        case .synthwaveHorizon:  synthwave
        case .hudScanlines:      hud
        case .terminalCRT:       terminal
        case .paperEditorial:    paper
        case .glassMaterial:     glass
        case .auroraDrift:       aurora
        case .blueprintTechnical: blueprint
        case .noiseBrutal:       noise
        case .mintEditorial:     mint
        }
    }

    // MARK: - Noise (neobrutalist)

    /// Flat canary yellow + heavy black bottom border. Hero number sits on
    /// top in heaviest black weight. Zero gradients, zero subtlety.
    private var noise: some View {
        ZStack(alignment: .topTrailing) {
            Color(red: 1.000, green: 0.851, blue: 0.239)
            Rectangle()
                .stroke(Color.black, lineWidth: 3)
                .padding(EdgeInsets(top: -3, leading: -3, bottom: 0, trailing: -3))
        }
    }

    // MARK: - Lagoon (legacy Aurora identifier)

    private var aurora: some View {
        ZStack(alignment: .bottom) {
            LinearGradient(colors: [Color(red: 0.025, green: 0.19, blue: 0.18),
                                    Color(red: 0.035, green: 0.12, blue: 0.15)],
                           startPoint: .topLeading, endPoint: .bottomTrailing)
            Rectangle().fill(c.secondary.opacity(0.6)).frame(height: 2)
        }
    }

    // MARK: - Prism (legacy Nebula identifier)
    private var nebula: some View {
        PrismHeroBackdrop(colors: c)
    }

    // MARK: - Carbon (legacy Nocturne identifier)

    private var nocturne: some View {
        ZStack(alignment: .bottomLeading) {
            Color(red: 0.105, green: 0.105, blue: 0.11)
            Rectangle().fill(c.highlight).frame(width: 60, height: 2)
        }
    }

    // MARK: - Terminal
    /// Pure black CRT readout with dense 2pt scanlines, phosphor halo, and
    /// a soft corner vignette for curvature.
    private var terminal: some View {
        ZStack {
            Color.black
            GeometryReader { geo in
                Path { p in
                    let count = Int(geo.size.height / 2)
                    for i in 0..<count {
                        let y = CGFloat(i) * 2
                        p.move(to: CGPoint(x: 0, y: y))
                        p.addLine(to: CGPoint(x: geo.size.width, y: y))
                    }
                }
                .stroke(c.secondary.opacity(0.08), lineWidth: 0.5)
            }
            .allowsHitTesting(false)
            RadialGradient(
                colors: [c.secondary.opacity(0.18), Color.clear],
                center: .bottomLeading, startRadius: 10, endRadius: 220
            )
            RadialGradient(
                colors: [Color.clear, Color.black.opacity(0.50)],
                center: .center, startRadius: 60, endRadius: 260
            )
            .blendMode(.multiply)
        }
    }

    // MARK: - Paper
    /// Warm cream editorial canvas with a thin horizontal rule and a very
    /// faint diagonal gradient for paper texture.
    private var paper: some View {
        ZStack {
            Color(red: 0.962, green: 0.943, blue: 0.904)
            GeometryReader { geo in
                Path { p in
                    p.move(to: CGPoint(x: 18, y: 40))
                    p.addLine(to: CGPoint(x: geo.size.width - 18, y: 40))
                }
                .stroke(Color.black.opacity(0.16), lineWidth: 0.5)
            }
            LinearGradient(
                colors: [
                    Color(red: 0.97, green: 0.95, blue: 0.91),
                    Color(red: 0.94, green: 0.92, blue: 0.87),
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            .blendMode(.multiply).opacity(0.5)
        }
    }

    // MARK: - Glass
    /// The header is a thin frosted surface over the shared desktop blur.
    private var glass: some View {
        LinearGradient(colors: [Color.white.opacity(0.20), Color.white.opacity(0.06), Color.clear],
                       startPoint: .topLeading, endPoint: .bottomTrailing)
    }
}
