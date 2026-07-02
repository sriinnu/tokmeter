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

/// Friendly "nothing happening yet" doodle: a sketched ∞ dozing under a little
/// trail of z's. Used by empty states.
struct QuietDoodle: View {
    let theme: AppTheme
    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            InfinityDoodle()
                .stroke(
                    c.accent.opacity(0.75),
                    style: StrokeStyle(lineWidth: 3, lineCap: .round, lineJoin: .round)
                )
                .frame(width: 58, height: 26)
                // A hair of rotation reads as hand-drawn, not machined.
                .rotationEffect(.degrees(-4))

            // z z z drifting up-right, shrinking — the universal "asleep" cue.
            HStack(alignment: .bottom, spacing: 2) {
                Text("z").font(.system(size: 9, weight: .bold, design: .rounded))
                Text("z").font(.system(size: 12, weight: .bold, design: .rounded))
                Text("z").font(.system(size: 15, weight: .bold, design: .rounded))
            }
            .foregroundColor(c.accent.opacity(0.55))
            .offset(x: 30, y: -18)
        }
        .frame(width: 96, height: 52)
        .accessibilityHidden(true)
    }
}
