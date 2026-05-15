// HubCard.swift — Themed card wrapper + empty-state used across the Hub.
// Centralizes the spacing, fill, border, and corner radius so every panel
// looks like it belongs to the same family.

import SwiftUI

/// Themed card wrapper used by every surface in the Hub so spacing, fill,
/// border, and hover behavior stay consistent.
struct HubCard<Content: View>: View {
    let theme: AppTheme
    let content: () -> Content

    init(theme: AppTheme, @ViewBuilder content: @escaping () -> Content) {
        self.theme = theme
        self.content = content
    }

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        content()
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(Color.primary.opacity(bg.isLight ? 0.03 : 0.05))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(c.accent.opacity(0.12), lineWidth: 1)
                    )
            )
    }
}

struct HubEmptyState: View {
    let icon: String
    let message: String
    let theme: AppTheme

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 24, weight: .light))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            Text(message)
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }
}
