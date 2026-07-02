// DoodleView.swift — playful hand-drawn vector doodles for quiet moments.
//
// A cost meter can read clinical; a little illustration in the otherwise-empty
// states adds warmth without cluttering the data views. Drawn with SwiftUI
// Paths (not SF Symbols) so they read as illustrations, and riffing on the
// app's ∞ brand mark so they feel like tokmeter, not stock clip-art. Themed to
// the accent so they adapt to every palette.

import SwiftUI

/// The ∞ mark as two overlapping hand-drawn loops with a gentle wobble — the
/// tokmeter silhouette, sketched rather than iconographic.
struct InfinityDoodle: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let r = min(rect.height, rect.width / 2.2) / 2
        let cy = rect.midY
        let leftX = rect.minX + r + rect.width * 0.06
        let rightX = rect.maxX - r - rect.width * 0.06
        p.addEllipse(in: CGRect(x: leftX - r, y: cy - r, width: r * 2, height: r * 2))
        p.addEllipse(in: CGRect(x: rightX - r, y: cy - r, width: r * 2, height: r * 2))
        return p
    }
}

/// A little ∞ mascot with eyes — the two loops read as a friendly face. It
/// breathes, floats, and glances around, with the occasional blink, so an
/// "Tok" — the tokmeter mascot as a full vector doodle: a squircle head with
/// ∞ eyes + pupils, blushing cheeks, a little smile, and a signal antenna that
/// sparks. Idles with a breath, an occasional blink, and a pulsing antenna.
/// All composed from Paths/shapes and themed to the accent.
struct TokMascot: View {
    let theme: AppTheme
    /// Renders in a 120pt box; `scale` shrinks/grows it and reserves the
    /// matching layout size so it drops into headers and sidebars cleanly.
    var scale: CGFloat = 1
    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    @State private var breathe = false
    @State private var spark = false

    var body: some View {
        ZStack {
            // ── Grounding shadow — soft ellipse under the body sells depth ──
            Ellipse()
                .fill(Color.black.opacity(0.14))
                .frame(width: 68, height: 11)
                .blur(radius: 3.5)
                .scaleEffect(x: breathe ? 1.0 : 0.88)
                .position(x: 60, y: 113)

            // ── Antenna + glowing signal spark ──
            Path { p in
                p.move(to: CGPoint(x: 60, y: 28))
                p.addLine(to: CGPoint(x: 60, y: 12))
            }
            .stroke(c.accent.opacity(0.7), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            Circle()
                .fill(RadialGradient(colors: [c.warm, c.accent], center: .center, startRadius: 0, endRadius: 6))
                .frame(width: 9, height: 9)
                .position(x: 60, y: 11)
                .scaleEffect(spark ? 1.4 : 0.85)
                // Fixed shadow radius (animating radius re-rasterizes every
                // frame); the pulse comes from scaleEffect + a soft glow ring.
                .shadow(color: c.accent.opacity(0.4), radius: 4)

            // ── Feet ──
            Capsule().fill(c.secondary).frame(width: 16, height: 9).position(x: 47, y: 103)
            Capsule().fill(c.secondary).frame(width: 16, height: 9).position(x: 73, y: 103)

            // ── Body: gradient squircle with drop shadow + glossy highlight ──
            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [c.primary, c.secondary],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .frame(width: 86, height: 78)
                .shadow(color: .black.opacity(0.22), radius: 9, y: 5)
                .overlay(
                    RoundedRectangle(cornerRadius: 28, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [.white.opacity(0.28), .clear],
                                startPoint: .top, endPoint: .center
                            )
                        )
                        .frame(width: 86, height: 78)
                )
                .position(x: 60, y: 64)

            // ── Blushing cheeks (soft radial) ──
            cheek.position(x: 33, y: 70)
            cheek.position(x: 87, y: 70)

            // ── ∞ eyes (white, blinking) ──
            eyes.position(x: 60, y: 56)

            // ── Smile ──
            Path { p in
                p.move(to: CGPoint(x: 50, y: 78))
                p.addQuadCurve(to: CGPoint(x: 70, y: 78), control: CGPoint(x: 60, y: 87))
            }
            .stroke(.white.opacity(0.9), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))

            // ── Belly "meter" screen with a live ∞ pulse ──
            RoundedRectangle(cornerRadius: 5, style: .continuous)
                .fill(Color.black.opacity(0.28))
                .frame(width: 36, height: 15)
                .overlay(
                    InfinityDoodle()
                        .stroke(c.warm, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                        .frame(width: 22, height: 9)
                        .opacity(spark ? 1 : 0.45)
                )
                .position(x: 60, y: 92)
        }
        .frame(width: 120, height: 120)
        .scaleEffect(breathe ? 1.03 : 0.98, anchor: .bottom)
        .offset(y: breathe ? 0 : -2)
        .onAppear {
            withAnimation(.easeInOut(duration: 2.8).repeatForever(autoreverses: true)) {
                breathe = true
            }
            withAnimation(.easeInOut(duration: 1.4).repeatForever(autoreverses: true)) {
                spark = true
            }
        }
        .accessibilityHidden(true)
        // Apply the caller's size scale and reserve the matching layout box.
        .scaleEffect(scale, anchor: .center)
        .frame(width: 120 * scale, height: 120 * scale)
    }

    /// Soft radial blush for the cheeks.
    private var cheek: some View {
        Circle()
            .fill(
                RadialGradient(
                    colors: [c.warm.opacity(0.6), c.warm.opacity(0)],
                    center: .center, startRadius: 0, endRadius: 8
                )
            )
            .frame(width: 16, height: 16)
    }

    private var eyes: some View {
        ZStack {
            // White ∞ "glasses" pop on the green gradient body.
            InfinityDoodle()
                .stroke(
                    Color.white.opacity(0.95),
                    style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 46, height: 20)
            PhaseAnimator([0, 1, 2, 3], content: { phase in
                HStack(spacing: 20) {
                    pupil(open: phase != 3)
                    pupil(open: phase != 3)
                }
            }, animation: { phase in
                phase == 3 ? .easeInOut(duration: 0.11) : .easeInOut(duration: 1.5)
            })
        }
    }

    private func pupil(open: Bool) -> some View {
        Circle()
            .fill(Color.white)
            .frame(width: 6, height: 6)
            .scaleEffect(x: 1, y: open ? 1 : 0.15, anchor: .center)
    }
}

/// Compact Tok face — head + blinking ∞ eyes + smile, no antenna/feet — sized
/// to read as a small wordmark glyph (e.g. replacing the ♾️ in the popover).
struct TokFace: View {
    let theme: AppTheme
    var size: CGFloat = 26
    private var c: ThemeColors { theme.colors }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: size * 0.34, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: [c.primary, c.secondary],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .frame(width: size, height: size * 0.92)
                .shadow(color: .black.opacity(0.18), radius: 1.5, y: 1)

            VStack(spacing: size * 0.06) {
                PhaseAnimator([0, 1, 2, 3], content: { phase in
                    HStack(spacing: size * 0.14) {
                        eye(open: phase != 3)
                        eye(open: phase != 3)
                    }
                }, animation: { phase in
                    phase == 3 ? .easeInOut(duration: 0.11) : .easeInOut(duration: 1.6)
                })
                Path { p in
                    let w = size * 0.34
                    p.move(to: CGPoint(x: 0, y: 0))
                    p.addQuadCurve(to: CGPoint(x: w, y: 0), control: CGPoint(x: w / 2, y: size * 0.12))
                }
                .stroke(.white.opacity(0.9), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                .frame(width: size * 0.34, height: size * 0.12)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func eye(open: Bool) -> some View {
        Circle()
            .fill(.white)
            .frame(width: size * 0.16, height: size * 0.16)
            .scaleEffect(x: 1, y: open ? 1 : 0.18, anchor: .center)
    }
}

/// Friendly "nothing happening yet" doodle: a sketched ∞ dozing while a stream
/// of z's rises and fades. Animated — the ∞ breathes on a slow sleep rhythm and
/// bobs gently; the z's float up staggered. All GPU-driven repeatForever
/// animations (no timers), so it's cheap even while an empty state lingers.
struct QuietDoodle: View {
    let theme: AppTheme
    private var c: ThemeColors { theme.colors }

    // Two independent loops: a slow breath for the mark, a rising drift for z's.
    @State private var breathe = false
    @State private var drift = false

    var body: some View {
        ZStack(alignment: .center) {
            InfinityDoodle()
                .stroke(
                    c.accent.opacity(0.78),
                    style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 58, height: 26)
                // Sleeping breath: slow in-out scale + a hair of tilt/bob so it
                // reads as alive and hand-drawn, not a static glyph.
                .scaleEffect(breathe ? 1.06 : 0.96, anchor: .center)
                .rotationEffect(.degrees(breathe ? -2 : -6))
                .offset(y: breathe ? 1.5 : -1.5)
                .animation(.easeInOut(duration: 2.4).repeatForever(autoreverses: true), value: breathe)

            // Three z's rising up-right and fading, each staggered — a little
            // stream of sleep rather than a static "zzz".
            ForEach(0..<3, id: \.self) { i in
                Text("z")
                    .font(.system(size: 9 + CGFloat(i) * 3, weight: .bold, design: .rounded))
                    .foregroundColor(c.accent.opacity(0.6))
                    .offset(x: 26 + CGFloat(i) * 5, y: drift ? -26 : -4)
                    .opacity(drift ? 0 : 0.7)
                    .animation(
                        .easeIn(duration: 2.4)
                            .repeatForever(autoreverses: false)
                            .delay(Double(i) * 0.7),
                        value: drift
                    )
            }
        }
        .frame(width: 104, height: 56)
        .onAppear {
            breathe = true
            drift = true
        }
        .accessibilityHidden(true)
    }
}
