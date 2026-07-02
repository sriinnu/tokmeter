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
/// always-visible spot (the Hub sidebar) gains a living companion rather than a
/// static glyph. GPU-driven loops + a blink phase; no timers.
struct InfinityMascot: View {
    let theme: AppTheme
    var tint: Color?
    private var c: ThemeColors { theme.colors }
    private var accent: Color { tint ?? c.accent }

    @State private var breathe = false
    @State private var look = false

    var body: some View {
        ZStack {
            InfinityDoodle()
                .stroke(
                    accent.opacity(0.8),
                    style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 54, height: 24)

            // Pupils sit inside each loop and drift together (looking around),
            // then blink on a slow phase cycle.
            PhaseAnimator([0, 1, 2, 3], content: { phase in
                HStack(spacing: 24) {
                    pupil(blinkPhase: phase)
                    pupil(blinkPhase: phase)
                }
                .offset(x: look ? 3 : -3)
            }, animation: { phase in
                // Long open holds, a quick blink between — phases 0→1→2 are the
                // eyes-open drift, 3 is the blink.
                phase == 3 ? .easeInOut(duration: 0.12) : .easeInOut(duration: 1.6)
            })
        }
        .scaleEffect(breathe ? 1.05 : 0.97, anchor: .center)
        .offset(y: breathe ? 1 : -1)
        .frame(width: 92, height: 44)
        .onAppear {
            withAnimation(.easeInOut(duration: 2.8).repeatForever(autoreverses: true)) {
                breathe = true
            }
            withAnimation(.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
                look = true
            }
        }
        .accessibilityHidden(true)
    }

    private func pupil(blinkPhase: Int) -> some View {
        Circle()
            .fill(accent)
            .frame(width: 5.5, height: 5.5)
            // Squash to a slit on the blink phase.
            .scaleEffect(x: 1, y: blinkPhase == 3 ? 0.15 : 1, anchor: .center)
    }
}

/// "Tok" — the tokmeter mascot as a full vector doodle: a squircle head with
/// ∞ eyes + pupils, blushing cheeks, a little smile, and a signal antenna that
/// sparks. Idles with a breath, an occasional blink, and a pulsing antenna.
/// All composed from Paths/shapes and themed to the accent.
struct TokMascot: View {
    let theme: AppTheme
    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    @State private var breathe = false
    @State private var spark = false

    var body: some View {
        ZStack {
            // ── Antenna + sparking signal dot ──
            Path { p in
                p.move(to: CGPoint(x: 60, y: 30))
                p.addLine(to: CGPoint(x: 60, y: 12))
            }
            .stroke(c.accent.opacity(0.6), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            Circle()
                .fill(c.accent)
                .frame(width: 8, height: 8)
                .position(x: 60, y: 11)
                .scaleEffect(spark ? 1.35 : 0.85)
                .shadow(color: c.accent.opacity(spark ? 0.7 : 0.2), radius: spark ? 5 : 1)

            // ── Head (squircle) ──
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(c.accent.opacity(bg.isLight ? 0.12 : 0.16))
                .overlay(
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .stroke(c.accent.opacity(0.55), lineWidth: 2.5)
                )
                .frame(width: 84, height: 74)
                .position(x: 60, y: 70)

            // ── Blushing cheeks ──
            Circle().fill(c.warm.opacity(0.35)).frame(width: 12, height: 12).position(x: 34, y: 82)
            Circle().fill(c.warm.opacity(0.35)).frame(width: 12, height: 12).position(x: 86, y: 82)

            // ── ∞ eyes with blinking pupils ──
            eyes.position(x: 60, y: 62)

            // ── Smile ──
            Path { p in
                p.move(to: CGPoint(x: 48, y: 86))
                p.addQuadCurve(to: CGPoint(x: 72, y: 86), control: CGPoint(x: 60, y: 96))
            }
            .stroke(c.accent.opacity(0.7), style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
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
    }

    private var eyes: some View {
        ZStack {
            InfinityDoodle()
                .stroke(
                    c.accent.opacity(0.85),
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
            .fill(c.accent)
            .frame(width: 6, height: 6)
            .scaleEffect(x: 1, y: open ? 1 : 0.15, anchor: .center)
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
