// CardBackground.swift — theme-aware chrome drawn behind every KPI card.
//
// Kept separate from StatCards.swift so adding a new theme doesn't bloat the
// card-layout file. Also hosts `CornerTicks`, the tiny L-shaped flourishes
// that reinforce HUD / Terminal's instrument-panel feel.

import SwiftUI

/// Theme-driven card backdrop. Apply via `.background(CardBackground(...))`.
struct CardBackground: View {
    let role: Color
    let cardMode: CardMode
    let themeColors: ThemeColors

    var body: some View {
        let radius = cardMode.cornerRadius
        switch cardMode {
        case .lightPaper:
            // Daylight: white paper, crisp shadow, role-colored top edge.
            RoundedRectangle(cornerRadius: radius)
                .fill(Color.white)
                .overlay(alignment: .top) {
                    Rectangle()
                        .fill(role.opacity(0.55))
                        .frame(height: 2)
                        .clipShape(UnevenRoundedRectangle(
                            cornerRadii: .init(topLeading: radius, topTrailing: radius),
                            style: .continuous))
                }
                .shadow(color: Color.black.opacity(0.08), radius: 8, x: 0, y: 3)
                .shadow(color: Color.black.opacity(0.04), radius: 1, x: 0, y: 1)

        case .neonOutlined:
            // Synthwave: thick neon border + blur glow + near-black fill.
            RoundedRectangle(cornerRadius: radius)
                .fill(LinearGradient(
                    colors: [
                        Color(red: 0.09, green: 0.04, blue: 0.14),
                        Color(red: 0.06, green: 0.02, blue: 0.10),
                    ],
                    startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: radius).strokeBorder(role, lineWidth: 1.4))
                .overlay(RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(role.opacity(0.4), lineWidth: 3).blur(radius: 3))
                .shadow(color: role.opacity(0.55), radius: 6)

        case .hudPanel:
            // HUD: role tint + thin border + corner ticks.
            ZStack {
                RoundedRectangle(cornerRadius: radius)
                    .fill(LinearGradient(
                        colors: [role.opacity(0.08), role.opacity(0.03)],
                        startPoint: .top, endPoint: .bottom))
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(role.opacity(0.45), lineWidth: 0.8)
                CornerTicks(color: role.opacity(0.75), lineWidth: 0.9, tickSize: 5)
            }

        case .glossyDark:
            // Nebula: color-tint fill, inner top highlight, role glow.
            ZStack {
                RoundedRectangle(cornerRadius: radius)
                    .fill(LinearGradient(
                        colors: [role.opacity(0.16), role.opacity(0.06)],
                        startPoint: .top, endPoint: .bottom))
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(
                        LinearGradient(
                            colors: [Color.white.opacity(0.22), Color.clear],
                            startPoint: .top, endPoint: .center),
                        lineWidth: 1
                    )
            }
            .shadow(color: role.opacity(0.30), radius: 8, x: 0, y: 3)
            .shadow(color: Color.black.opacity(0.25), radius: 1, x: 0, y: 1)

        case .flatDark:
            ZStack {
                RoundedRectangle(cornerRadius: radius).fill(role.opacity(0.09))
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color.white.opacity(0.07), lineWidth: 0.8)
            }

        case .terminalPanel:
            ZStack {
                RoundedRectangle(cornerRadius: radius).fill(Color.black)
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(role.opacity(0.55), lineWidth: 0.8)
                CornerTicks(color: role, lineWidth: 0.8, tickSize: 4)
            }

        case .paperHairline:
            ZStack {
                RoundedRectangle(cornerRadius: radius)
                    .fill(Color.white.opacity(0.55))
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color.black.opacity(0.20), lineWidth: 0.6)
                GeometryReader { _ in
                    Rectangle()
                        .fill(role.opacity(0.85))
                        .frame(width: 24, height: 1.5)
                        .offset(x: 10, y: 0)
                }
            }

        case .glassFrost:
            ZStack {
                RoundedRectangle(cornerRadius: radius).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: radius).fill(role.opacity(0.08))
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(LinearGradient(
                        colors: [Color.white.opacity(0.35), Color.white.opacity(0.05)],
                        startPoint: .top, endPoint: .bottom
                    ), lineWidth: 1)
            }
            .shadow(color: Color.black.opacity(0.15), radius: 8, x: 0, y: 4)

        case .auroraGlass:
            // Thin material that lets the drifting bg show through, with a
            // soft role-tinted glow at the top edge — like aurora light
            // catching the lip of a glass shelf.
            ZStack {
                RoundedRectangle(cornerRadius: radius).fill(.ultraThinMaterial)
                RoundedRectangle(cornerRadius: radius).fill(role.opacity(0.10))
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(LinearGradient(
                        colors: [role.opacity(0.45), Color.white.opacity(0.06)],
                        startPoint: .top, endPoint: .bottom
                    ), lineWidth: 0.8)
            }
            .shadow(color: Color.black.opacity(0.30), radius: 10, x: 0, y: 4)

        case .blueprintFrame:
            ZStack {
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(role.opacity(0.55), lineWidth: 0.8)
                RoundedRectangle(cornerRadius: radius)
                    .fill(Color.white.opacity(0.20))
            }

        case .noiseStuck:
            // Solid white fill + chunky 2pt black border + 3pt HARD offset
            // shadow (no blur, no opacity). Reads as "sticky note stuck on
            // a yellow board." The chrome IS the personality.
            ZStack {
                // Hard offset shadow — black, no blur, no alpha
                RoundedRectangle(cornerRadius: radius)
                    .fill(Color.black)
                    .offset(x: 3, y: 3)
                RoundedRectangle(cornerRadius: radius)
                    .fill(Color.white)
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color.black, lineWidth: 2)
            }

        case .mintHairline:
            // Solid white fill + 1pt black hairline. The translucent version
            // read as washed-out on peach; solid cards feel like objects ON
            // the surface (the reference app's discipline). 14pt rounded
            // corners stay pill-friendly.
            ZStack {
                RoundedRectangle(cornerRadius: radius)
                    .fill(Color.white)
                RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color.black.opacity(0.55), lineWidth: 1.0)
            }
        }
    }
}

/// Four tiny L-shaped ticks at each corner of a card — reinforces the HUD
/// and Terminal instrument-panel feel without adding clutter.
struct CornerTicks: View {
    let color: Color
    let lineWidth: CGFloat
    let tickSize: CGFloat

    var body: some View {
        GeometryReader { geo in
            Path { p in
                let s = tickSize
                let w = geo.size.width; let h = geo.size.height
                p.move(to: CGPoint(x: 3, y: s + 3)); p.addLine(to: CGPoint(x: 3, y: 3)); p.addLine(to: CGPoint(x: s + 3, y: 3))
                p.move(to: CGPoint(x: w - 3, y: s + 3)); p.addLine(to: CGPoint(x: w - 3, y: 3)); p.addLine(to: CGPoint(x: w - s - 3, y: 3))
                p.move(to: CGPoint(x: 3, y: h - s - 3)); p.addLine(to: CGPoint(x: 3, y: h - 3)); p.addLine(to: CGPoint(x: s + 3, y: h - 3))
                p.move(to: CGPoint(x: w - 3, y: h - s - 3)); p.addLine(to: CGPoint(x: w - 3, y: h - 3)); p.addLine(to: CGPoint(x: w - s - 3, y: h - 3))
            }
            .stroke(color, lineWidth: lineWidth)
        }
        .allowsHitTesting(false)
    }
}
