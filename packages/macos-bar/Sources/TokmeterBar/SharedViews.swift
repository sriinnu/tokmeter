// SharedViews.swift — tiny reusable view pieces used by more than one file.
//
// Kept here instead of duplicating across files or cluttering Formatters.swift
// (which is string-only). Each view is purposefully small and stateless.

import SwiftUI

/// A subtle loading bar that slowly breathes opacity. Used as a placeholder
/// while the daemon is warming up — better than rendering "0" which reads as
/// real data.
struct ShimmerBar: View {
    let width: CGFloat
    let height: CGFloat
    /// Parent-driven breath toggle so the shimmer syncs with the hero animations.
    let breathToggle: Bool

    var body: some View {
        RoundedRectangle(cornerRadius: height / 3)
            .fill(
                LinearGradient(
                    colors: [
                        Color.gray.opacity(0.15),
                        Color.gray.opacity(0.25),
                        Color.gray.opacity(0.15),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .frame(width: width, height: height)
            .opacity(breathToggle ? 0.7 : 0.3)
            .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: breathToggle)
    }
}

/// Staged entrance modifier — content fades in and settles down from a small
/// upward offset after the given delay. Used to cascade the popover's sections
/// so the whole UI doesn't pop at once. Set per-view delay to stage the sequence:
/// hero @ 0.02s, cards @ 0.12s, models @ 0.20s, week @ 0.28s, sessions @ 0.36s,
/// footer @ 0.44s.
struct CascadeIn: ViewModifier {
    let delay: Double
    @State private var appeared = false

    func body(content: Content) -> some View {
        // The entrance is ONE in-transaction state write, not a deferred
        // `asyncAfter` + implicit `.animation`. The old form scheduled N staggered
        // POST-layout `@State` writes (one per cascaded section, every panel) that
        // each re-ran the graph and re-dirtied the window's Update-Constraints pass
        // AFTER layout had settled — at large width that re-entrancy never
        // converges and AppKit throws "more Update Constraints passes than views".
        // `withAnimation(...).delay()` keeps the staggered fade as a render-only
        // opacity animation driven by a single write inside the layout transaction.
        content
            .opacity(appeared ? 1 : 0)
            .onAppear {
                withAnimation(.easeOut(duration: 0.3).delay(delay)) {
                    appeared = true
                }
            }
    }
}

extension View {
    /// Apply a staged cascade entrance. See `CascadeIn`.
    func cascadeIn(delay: Double) -> some View {
        modifier(CascadeIn(delay: delay))
    }
}

/// Generic section header with an optional count pill. Every data section in
/// the popover uses this so labels stay consistent.
struct SectionHeader: View {
    let label: String
    let count: Int
    let theme: AppTheme

    /// Briefly bumped to >1 when `count` changes so the pill catches the eye.
    @State private var pulseScale: CGFloat = 1.0

    var body: some View {
        HStack {
            Text(label)
                .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
                .tracking(1.2)
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            if count > 0 {
                Text("\(count)")
                    .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.gray.opacity(0.15)))
                    .contentTransition(.numericText())
                    .scaleEffect(pulseScale)
                    .onChange(of: count) { _, _ in
                        pulseScale = 1.18
                        withAnimation(.spring(response: 0.35, dampingFraction: 0.55)) {
                            pulseScale = 1.0
                        }
                    }
            }
            Spacer()
        }
    }
}
