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

    // MARK: - Aurora

    /// Drifting northern-lights gradient. The MeshGradient stops shift their
    /// positions on a slow 60s cycle so the bg is alive but never flashy —
    /// motion as identity, not motion as ornament. Apple's macOS Sonoma
    /// "Sky" wallpapers are the lineage. Performance: the only animated
    /// view in the entire bar; runs on Core Animation off the main thread.
    private var aurora: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            let t = timeline.date.timeIntervalSinceReferenceDate
            // 45/60/75s phased periods — faster than the initial pass so the
            // motion is actually visible without being distracting. Each
            // stop drifts on its own phase to keep the pattern non-looping.
            let p1 = sin(t * 2 * .pi / 45)
            let p2 = cos(t * 2 * .pi / 75)
            let p3 = sin(t * 2 * .pi / 60)
            ZStack {
                // Solid base anchor.
                Color(red: 0.02, green: 0.03, blue: 0.08)
                // Three radial gradients drift independently with stronger
                // peak intensities than v1 — "curtain of light" should land
                // as luminous, not subliminal.
                RadialGradient(
                    colors: [c.secondary.opacity(0.78), c.secondary.opacity(0.10), Color.clear],
                    center: UnitPoint(x: 0.25 + p1 * 0.22, y: 0.30 + p2 * 0.16),
                    startRadius: 15, endRadius: 320
                )
                RadialGradient(
                    colors: [c.accent.opacity(0.65), c.accent.opacity(0.08), Color.clear],
                    center: UnitPoint(x: 0.72 + p3 * 0.20, y: 0.55 + p1 * 0.14),
                    startRadius: 20, endRadius: 360
                )
                RadialGradient(
                    colors: [c.tertiary.opacity(0.45), Color.clear],
                    center: UnitPoint(x: 0.50 + p2 * 0.25, y: 0.20 + p3 * 0.12),
                    startRadius: 30, endRadius: 280
                )
                // Faint star-like specular over the top.
                RadialGradient(
                    colors: [Color.white.opacity(0.08), Color.clear],
                    center: .top, startRadius: 0, endRadius: 220
                )
            }
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
    /// Solid deep indigo with a slowly-pulsing corner glow and a faint
    /// starfield. The pulse breathes between 0.6 and 1.0 opacity over 5s.
    private var nocturne: some View {
        ZStack(alignment: .topTrailing) {
            c.primary
            RadialGradient(
                colors: [c.accent.opacity(0.35), c.accent.opacity(0.0)],
                center: .topTrailing, startRadius: 20, endRadius: 260
            )
            // Soft breathing — opacity oscillates so the glow feels alive
            // without changing color or position. Keyed off breathToggle so
            // it shares the same rhythm as the hero's other ambient motion.
            .opacity(breathToggle ? 1.0 : 0.55)
            .animation(.easeInOut(duration: 5).repeatForever(autoreverses: true), value: breathToggle)

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
    /// Translucent regular-material + color tint + a top gloss that gently
    /// shimmers — the glass appears to catch and lose light over a slow cycle.
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
            // Top gloss with breathing intensity — opacity oscillates 0.14↔0.28
            // so the glass plate "catches the light" subtly over 6s.
            LinearGradient(
                colors: [Color.white.opacity(breathToggle ? 0.28 : 0.14), Color.clear],
                startPoint: .top, endPoint: .center
            )
            .animation(.easeInOut(duration: 6).repeatForever(autoreverses: true), value: breathToggle)
        }
    }
}
