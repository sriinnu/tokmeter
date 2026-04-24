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

    private var c: ThemeColors { theme.colors }

    var body: some View {
        switch theme.heroMode {
        case .nebulaGradient:   nebula
        case .nocturneCalm:     nocturne
        case .daylightSoft:     daylight
        case .synthwaveHorizon: synthwave
        case .hudScanlines:     hud
        case .terminalCRT:      terminal
        case .paperEditorial:   paper
        case .glassMaterial:    glass
        }
    }

    // MARK: - Nebula
    /// Deep purple → magenta → warm orange diagonal with a slow breathing
    /// white overlay and a corner vignette. The identity look.
    private var nebula: some View {
        ZStack {
            LinearGradient(
                colors: [c.primary, c.secondary, c.warm, c.highlight],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [Color.clear, Color.black.opacity(0.22)],
                center: .bottomTrailing, startRadius: 100, endRadius: 400
            )
            Color.white
                .opacity(breathToggle ? 0.08 : 0.0)
                .animation(.easeInOut(duration: 4).repeatForever(autoreverses: true), value: breathToggle)
        }
    }

    // MARK: - Nocturne
    /// Solid deep indigo with a single corner glow and a faint starfield.
    private var nocturne: some View {
        ZStack(alignment: .topTrailing) {
            c.primary
            RadialGradient(
                colors: [c.accent.opacity(0.35), c.accent.opacity(0.0)],
                center: .topTrailing, startRadius: 20, endRadius: 260
            )
            GeometryReader { geo in
                ForEach(0..<8, id: \.self) { i in
                    Circle()
                        .fill(Color.white.opacity(0.12))
                        .frame(width: 1.5, height: 1.5)
                        .position(
                            x: CGFloat((i * 47 + 13) % Int(geo.size.width)),
                            y: CGFloat((i * 31 + 8) % Int(geo.size.height))
                        )
                }
            }
            .allowsHitTesting(false)
        }
    }

    // MARK: - Daylight
    /// Cream paper washed with a soft multi-color gradient bloom, plus a
    /// subtle top light sheen. Dark foreground text makes this readable.
    private var daylight: some View {
        ZStack {
            Color(red: 0.975, green: 0.955, blue: 0.925)
            LinearGradient(
                colors: [
                    c.primary.opacity(0.35),
                    c.secondary.opacity(0.30),
                    c.accent.opacity(0.28),
                    c.highlight.opacity(0.25),
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            .blur(radius: 36).opacity(0.95)
            LinearGradient(
                colors: [Color.white.opacity(0.35), Color.clear],
                startPoint: .top, endPoint: .center
            )
        }
    }

    // MARK: - Synthwave
    /// Magenta sky, setting sun with three horizontal band slits, and a
    /// perspective grid fading toward the vanishing point at the horizon.
    private var synthwave: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.06, green: 0.02, blue: 0.15),
                    Color(red: 0.25, green: 0.06, blue: 0.32),
                    c.primary.opacity(0.78),
                    c.warm.opacity(0.58),
                ],
                startPoint: .top, endPoint: .bottom
            )
            GeometryReader { geo in
                let w = geo.size.width; let h = geo.size.height
                let horizon = h * 0.58
                // Grid rails below horizon
                Path { p in
                    for i in 0..<7 {
                        let t = CGFloat(i) / 6
                        let y = horizon + (h - horizon) * pow(t, 1.4)
                        p.move(to: CGPoint(x: 0, y: y))
                        p.addLine(to: CGPoint(x: w, y: y))
                    }
                }
                .stroke(c.secondary.opacity(0.55), lineWidth: 0.7)
                // Vanishing-point verticals
                Path { p in
                    let vx = w / 2; let vy = horizon
                    for i in -6...6 where i != 0 {
                        let x = vx + CGFloat(i) * (w / 8)
                        p.move(to: CGPoint(x: vx, y: vy))
                        p.addLine(to: CGPoint(x: x, y: h))
                    }
                }
                .stroke(c.secondary.opacity(0.35), lineWidth: 0.5)
                // Setting sun
                Circle()
                    .fill(LinearGradient(
                        colors: [c.warm, c.highlight, c.primary],
                        startPoint: .top, endPoint: .bottom))
                    .frame(width: min(w * 0.42, 140), height: min(w * 0.42, 140))
                    .position(x: w * 0.72, y: horizon + 4)
                    .shadow(color: c.warm.opacity(0.6), radius: 18)
                    .shadow(color: c.primary.opacity(0.5), radius: 30)
                // Sun band slits
                Path { p in
                    let cx = w * 0.72; let cy = horizon + 4
                    let r = min(w * 0.42, 140) / 2
                    for frac in [0.15, 0.30, 0.45] {
                        let y = cy - r + r * 2 * CGFloat(frac)
                        let dx = sqrt(max(r * r - (y - cy) * (y - cy), 0))
                        p.move(to: CGPoint(x: cx - dx, y: y))
                        p.addLine(to: CGPoint(x: cx + dx, y: y))
                    }
                }
                .stroke(c.primary.opacity(0.7), lineWidth: 1.5)
            }
            .allowsHitTesting(false)
        }
    }

    // MARK: - HUD
    /// Tactical dark panel + 4pt scanlines + green corner brackets.
    private var hud: some View {
        ZStack(alignment: .topLeading) {
            LinearGradient(
                colors: [
                    Color(red: 0.02, green: 0.07, blue: 0.05),
                    Color(red: 0.05, green: 0.11, blue: 0.08),
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [c.secondary.opacity(0.18), Color.clear],
                center: .bottomLeading, startRadius: 10, endRadius: 200
            )
            GeometryReader { geo in
                Path { p in
                    let count = Int(geo.size.height / 4)
                    for i in 0..<count {
                        let y = CGFloat(i) * 4
                        p.move(to: CGPoint(x: 0, y: y))
                        p.addLine(to: CGPoint(x: geo.size.width, y: y))
                    }
                }
                .stroke(c.secondary.opacity(0.05), lineWidth: 0.4)
            }
            .allowsHitTesting(false)
            GeometryReader { geo in
                Path { p in
                    let size: CGFloat = 14
                    let tl = CGPoint(x: 10, y: 12)
                    p.move(to: CGPoint(x: tl.x, y: tl.y + size))
                    p.addLine(to: tl)
                    p.addLine(to: CGPoint(x: tl.x + size, y: tl.y))
                    let tr = CGPoint(x: geo.size.width - 10, y: 12)
                    p.move(to: CGPoint(x: tr.x, y: tr.y + size))
                    p.addLine(to: tr)
                    p.addLine(to: CGPoint(x: tr.x - size, y: tr.y))
                }
                .stroke(c.secondary.opacity(0.55), lineWidth: 1.3)
            }
            .allowsHitTesting(false)
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
    /// Translucent regular-material panel + color tint + top gloss highlight.
    private var glass: some View {
        ZStack {
            Rectangle().fill(.regularMaterial)
            LinearGradient(
                colors: [
                    c.primary.opacity(0.22),
                    c.secondary.opacity(0.12),
                    c.accent.opacity(0.10),
                ],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            LinearGradient(
                colors: [Color.white.opacity(0.22), Color.clear],
                startPoint: .top, endPoint: .center
            )
        }
    }
}
