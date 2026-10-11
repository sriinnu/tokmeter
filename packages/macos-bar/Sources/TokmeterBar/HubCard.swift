// HubCard.swift — Themed card wrapper + empty-state used across the Hub.
// Centralizes the spacing, fill, border, and corner radius so every panel
// looks like it belongs to the same family.

import SwiftUI

/// Themed card wrapper used by every surface in the Hub so spacing, fill,
/// border, and hover behavior stay consistent.
struct HubCard<Content: View>: View {
    let theme: AppTheme
    /// A card inside another card. On Paper it takes a hairline instead of
    /// the 2pt section rule.
    var nested = false
    let content: () -> Content

    init(theme: AppTheme, nested: Bool = false, @ViewBuilder content: @escaping () -> Content) {
        self.theme = theme
        self.nested = nested
        self.content = content
    }

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private var panelRadius: CGFloat {
        theme == .nocturne ? 6 : (theme == .aurora ? 18 : 14)
    }

    private var panelFill: Color {
        switch theme {
        case .nocturne: return Color(red: 0.10, green: 0.10, blue: 0.105)
        case .aurora: return Color(red: 0.035, green: 0.135, blue: 0.14)
        default: return Color.primary.opacity(bg.isLight ? 0.03 : 0.05)
        }
    }

    var body: some View {
        if let skin = theme.skin {
            // A skin's own card, the same one its popover uses.
            content()
                .padding(nested ? 10 : 14)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(SkinCard(skin: skin, role: c.accent))
        } else if theme == .paper {
            // Broadsheet: a section is ruled, not boxed.
            VStack(alignment: .leading, spacing: 0) {
                InkRule(weight: nested ? 1 : 2)
                content()
                    .padding(.top, nested ? 8 : 12)
                    .padding(.bottom, nested ? 4 : 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            standardBody
        }
    }

    private var standardBody: some View {
        content()
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if theme == .nebula {
                    PrismPanel(colors: c)
                } else if bg.usesMaterial {
                    FrostedGlassPanel()
                } else {
                    RoundedRectangle(cornerRadius: panelRadius)
                        .fill(panelFill)
                        .overlay(
                            RoundedRectangle(cornerRadius: panelRadius)
                                .stroke(c.accent.opacity(0.12), lineWidth: 1)
                        )
                }
            }
    }
}

struct HubEmptyState: View {
    let icon: String
    let message: String
    let theme: AppTheme

    var body: some View {
        VStack(spacing: 10) {
            // A playful ∞-dozing doodle instead of a flat SF Symbol — empty
            // states are exactly where a little warmth helps and there's no
            // data to compete with. (`icon` retained for call-site compat.)
            QuietDoodle(theme: theme)
            Text(message)
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 26)
    }
}
