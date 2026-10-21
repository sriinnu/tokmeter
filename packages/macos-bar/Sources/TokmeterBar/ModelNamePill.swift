import SwiftUI

/// Hovering a model row shows the full model id (and its provider) in a small
/// pill over the row, a beat after the pointer settles. Row names are short
/// and truncate ("deepseek-fla…", "minimax-m3.1…"), and `.help` tooltips are
/// unreliable in the menubar panel.
///
/// An overlay, not a popover: an NSPopover takes key focus, and the menubar
/// panel closes when it resigns key. The overlay also leaves the row's layout
/// untouched, so the panel never resizes when the pill appears.
struct ModelNamePill: ViewModifier {
    let fullName: String
    let provider: String
    let theme: AppTheme

    @State private var hovering = false
    @State private var shown = false

    func body(content: Content) -> some View {
        content
            .overlay(alignment: .leading) {
                if shown {
                    ModelNamePillLabel(fullName: fullName, provider: provider, theme: theme)
                        .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: .leading)))
                }
            }
            .onHover { inside in
                hovering = inside
                if inside {
                    // Settle first, so sweeping across the list doesn't flash pills.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) {
                        guard hovering else { return }
                        withAnimation(.easeOut(duration: 0.14)) { shown = true }
                    }
                } else if shown {
                    withAnimation(.easeIn(duration: 0.1)) { shown = false }
                }
            }
    }
}

/// The pill itself, separate from the hover logic so it can be rendered and
/// checked in every theme.
struct ModelNamePillLabel: View {
    let fullName: String
    let provider: String
    let theme: AppTheme

    var body: some View {
        let mode = theme.backgroundMode
        return HStack(spacing: 6) {
            Text(fullName)
                .font(.system(size: 11, weight: .semibold, design: .monospaced))
                .foregroundColor(mode.primaryTextColor)
            if !provider.isEmpty {
                Text(provider)
                    .font(.system(size: 9, design: .monospaced))
                    .foregroundColor(mode.secondaryTextColor)
            }
        }
        .lineLimit(1)
        .fixedSize()
        .padding(.horizontal, 9)
        .padding(.vertical, 4)
        .background(
            Capsule().fill(mode.isLight ? Color.white.opacity(0.97) : Color.black.opacity(0.88))
        )
        .overlay(Capsule().strokeBorder(theme.colors.accent.opacity(0.55), lineWidth: 0.75))
        .shadow(color: .black.opacity(mode.isLight ? 0.12 : 0.45), radius: 5, y: 2)
        // Purely visual: it must not steal the hover that keeps it open, and
        // VoiceOver already has the full id as the row's accessibility hint.
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

extension View {
    func modelNamePill(_ fullName: String, provider: String, theme: AppTheme) -> some View {
        modifier(ModelNamePill(fullName: fullName, provider: provider, theme: theme))
    }
}
