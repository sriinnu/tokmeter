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
