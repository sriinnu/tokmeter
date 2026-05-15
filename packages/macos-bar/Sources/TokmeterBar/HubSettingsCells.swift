// HubSettingsCells.swift — Theme picker cell + action button used by
// HubSettings. Extracted to keep HubSettings.swift focused on the panel.

import SwiftUI

// ─── Theme picker cell (Hub-sized variant) ───────────────────────────────

struct HubThemePickerCell: View {
    let candidate: AppTheme
    let isSelected: Bool
    let currentTheme: AppTheme
    let onTap: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { candidate.colors }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 7)
                        .fill(
                            LinearGradient(
                                colors: [c.primary, c.secondary, c.warm],
                                startPoint: .topLeading, endPoint: .bottomTrailing
                            )
                        )
                        .frame(width: 34, height: 34)
                    Image(systemName: candidate.icon)
                        .font(.system(size: 14, weight: .bold))
                        .foregroundColor(.white)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(candidate.displayName)
                        .font(.system(size: 12, weight: .semibold,
                                      design: currentTheme.fonts.labelDesign))
                        .foregroundColor(currentTheme.backgroundMode.primaryTextColor)
                    Text(candidate.tagline)
                        .font(.system(size: 9,
                                      design: currentTheme.fonts.bodyDesign))
                        .foregroundColor(currentTheme.backgroundMode.secondaryTextColor)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 12, weight: .bold))
                        .foregroundColor(c.accent)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(isSelected ? c.accent.opacity(0.10) : Color.primary.opacity(hovered ? 0.06 : 0.0))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .stroke(isSelected ? c.accent.opacity(0.5) : Color.clear, lineWidth: 1)
                    )
            )
            .scaleEffect(isSelected ? 1.02 : (hovered ? 1.015 : 1.0))
            .offset(y: hovered ? -1 : 0)
        }
        .buttonStyle(.borderless)
        .animation(.spring(response: 0.40, dampingFraction: 0.60), value: isSelected)
        .animation(.spring(response: 0.28, dampingFraction: 0.72), value: hovered)
        .onHover { hovered = $0 }
    }
}

// ─── Action button (footer) ──────────────────────────────────────────────

enum HubButtonTint {
    case accent, warning
}

struct HubSettingsActionButton: View {
    let icon: String
    let label: String
    let theme: AppTheme
    let tint: HubButtonTint
    let action: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private var tintColor: Color {
        switch tint {
        case .accent:  return c.accent
        case .warning: return .orange
        }
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.system(size: 10, weight: .bold))
                Text(label)
                    .font(.system(size: 11, weight: .semibold, design: theme.fonts.labelDesign))
            }
            .foregroundColor(tintColor)
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .background(
                Capsule()
                    .fill(tintColor.opacity(hovered ? 0.22 : 0.12))
                    .overlay(Capsule().stroke(tintColor.opacity(0.45), lineWidth: 1))
            )
            .scaleEffect(hovered ? 1.03 : 1.0)
        }
        .buttonStyle(.borderless)
        .animation(.spring(response: 0.30, dampingFraction: 0.65), value: hovered)
        .onHover { hovered = $0 }
    }
}
