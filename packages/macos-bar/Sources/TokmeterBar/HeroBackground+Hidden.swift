// HeroBackground+Hidden.swift — renderers for themes hidden from the picker.
//
// Daylight, Synthwave, HUD, Blueprint, Mint all stay code-resident so any
// persisted user setting that happens to point at one still renders cleanly
// — but they're not in `AppTheme.allCases` so they don't appear in the
// theme picker. Living separately from the visible-theme renderers keeps
// HeroBackground.swift under the 450 LOC budget.

import SwiftUI

extension HeroBackground {

    // MARK: - Daylight
    /// Cream paper washed with a soft multi-color gradient bloom that drifts
    /// slowly between two start anchors, plus a top light sheen. Reads as
    /// clouds passing over paper.
    var daylight: some View {
        ZStack {
            Color(red: 0.975, green: 0.955, blue: 0.925)
            LinearGradient(
                colors: [
                    theme.colors.primary.opacity(0.35),
                    theme.colors.secondary.opacity(0.30),
                    theme.colors.accent.opacity(0.28),
                    theme.colors.highlight.opacity(0.25),
                ],
                startPoint: breathToggle ? .topTrailing : .topLeading,
                endPoint: breathToggle ? .bottomLeading : .bottomTrailing
            )
            .blur(radius: 36).opacity(0.95)
            .animation(.easeInOut(duration: 7).repeatForever(autoreverses: true), value: breathToggle)
            LinearGradient(
                colors: [Color.white.opacity(0.35), Color.clear],
                startPoint: .top, endPoint: .center
            )
        }
    }

    // MARK: - Synthwave
    /// Magenta sky, setting sun with three horizontal band slits, a
    /// perspective grid fading to the vanishing point, AND a slow sun pulse
    /// (radius modulated via shadow blur) so the horizon feels alive.
    var synthwave: some View {
        let c = theme.colors
        return ZStack {
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
                // Grid rails below horizon — animated phase scrolls the
                // horizontal lines TOWARD the horizon. 6s period, perspective-
                // warped via pow(t, 1.4).
                TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { tl in
                    let phase = CGFloat(tl.date.timeIntervalSinceReferenceDate
                        .truncatingRemainder(dividingBy: 6.0) / 6.0)
                    Path { p in
                        for i in 0..<8 {
                            let t = (CGFloat(i) / 7 + phase).truncatingRemainder(dividingBy: 1.0)
                            let y = horizon + (h - horizon) * pow(t, 1.4)
                            p.move(to: CGPoint(x: 0, y: y))
                            p.addLine(to: CGPoint(x: w, y: y))
                        }
                    }
                    .stroke(c.secondary.opacity(0.55), lineWidth: 0.7)
                }
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
                Circle()
                    .fill(LinearGradient(
                        colors: [c.warm, c.highlight, c.primary],
                        startPoint: .top, endPoint: .bottom))
                    .frame(width: min(w * 0.42, 140), height: min(w * 0.42, 140))
                    .position(x: w * 0.72, y: horizon + 4)
                    .shadow(color: c.warm.opacity(0.6), radius: breathToggle ? 22 : 14)
                    .shadow(color: c.primary.opacity(0.5), radius: breathToggle ? 34 : 26)
                    .animation(.easeInOut(duration: 4.5).repeatForever(autoreverses: true), value: breathToggle)
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
    var hud: some View {
        let c = theme.colors
        return ZStack(alignment: .topLeading) {
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

    // MARK: - Blueprint
    /// Drafting-paper hero: cream base, faint cyan grid, hairline frame
    /// border, and L-shaped corner ticks. Hidden from picker — the rest of
    /// the popover didn't share the drafting language, so this read as
    /// "worksheet with a sticker on top."
    var blueprint: some View {
        let c = theme.colors
        return ZStack {
            Color(red: 0.955, green: 0.945, blue: 0.910)
            Canvas { ctx, size in
                let major = c.accent.opacity(0.32)
                let minor = c.accent.opacity(0.14)
                var minorPath = Path()
                var majorPath = Path()
                let step: CGFloat = 10
                var x: CGFloat = 0
                var i = 0
                while x <= size.width {
                    if i % 4 == 0 {
                        majorPath.move(to: CGPoint(x: x, y: 0))
                        majorPath.addLine(to: CGPoint(x: x, y: size.height))
                    } else {
                        minorPath.move(to: CGPoint(x: x, y: 0))
                        minorPath.addLine(to: CGPoint(x: x, y: size.height))
                    }
                    x += step
                    i += 1
                }
                var y: CGFloat = 0
                i = 0
                while y <= size.height {
                    if i % 4 == 0 {
                        majorPath.move(to: CGPoint(x: 0, y: y))
                        majorPath.addLine(to: CGPoint(x: size.width, y: y))
                    } else {
                        minorPath.move(to: CGPoint(x: 0, y: y))
                        minorPath.addLine(to: CGPoint(x: size.width, y: y))
                    }
                    y += step
                    i += 1
                }
                ctx.stroke(minorPath, with: .color(minor), lineWidth: 0.5)
                ctx.stroke(majorPath, with: .color(major), lineWidth: 0.8)
            }
            Rectangle()
                .stroke(c.primary.opacity(0.55), lineWidth: 1.0)
                .padding(8)
            GeometryReader { geo in
                let w = geo.size.width; let h = geo.size.height
                let s: CGFloat = 14
                let inset: CGFloat = 8
                Path { p in
                    p.move(to: CGPoint(x: inset, y: inset + s))
                    p.addLine(to: CGPoint(x: inset, y: inset))
                    p.addLine(to: CGPoint(x: inset + s, y: inset))
                    p.move(to: CGPoint(x: w - inset - s, y: inset))
                    p.addLine(to: CGPoint(x: w - inset, y: inset))
                    p.addLine(to: CGPoint(x: w - inset, y: inset + s))
                    p.move(to: CGPoint(x: inset, y: h - inset - s))
                    p.addLine(to: CGPoint(x: inset, y: h - inset))
                    p.addLine(to: CGPoint(x: inset + s, y: h - inset))
                    p.move(to: CGPoint(x: w - inset - s, y: h - inset))
                    p.addLine(to: CGPoint(x: w - inset, y: h - inset))
                    p.addLine(to: CGPoint(x: w - inset, y: h - inset - s))
                }
                .stroke(c.primary.opacity(0.75), lineWidth: 1.5)
            }
        }
    }

    // MARK: - Mint
    /// Warm peach surface + chunky lime kicker block at the bottom + small
    /// lime pace-dot top-right. Hidden from picker — concept overlapped
    /// Paper without enough differentiation.
    var mint: some View {
        let c = theme.colors
        return ZStack(alignment: .bottomLeading) {
            Color(red: 1.000, green: 0.898, blue: 0.769)
            Rectangle()
                .fill(c.accent)
                .frame(height: 8)
            VStack {
                HStack {
                    Spacer()
                    Circle()
                        .fill(c.accent)
                        .frame(width: 10, height: 10)
                        .padding(.top, 14)
                        .padding(.trailing, 18)
                }
                Spacer()
            }
        }
    }
}
