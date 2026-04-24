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

/// Generic section header with an optional count pill. Every data section in
/// the popover uses this so labels stay consistent.
struct SectionHeader: View {
    let label: String
    let count: Int
    let theme: AppTheme

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
            }
            Spacer()
        }
    }
}
