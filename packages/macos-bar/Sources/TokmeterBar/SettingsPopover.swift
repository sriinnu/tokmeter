// SettingsPopover.swift — the settings sheet shown from the gear icon.
//
// Right now it holds the theme picker, a read-only refresh-interval row,
// and a "Open Config File" shortcut. Layout is a 2-column grid with a
// swatch + name + tagline per theme.

import SwiftUI

/// Settings popover. Owns no state of its own — the theme picker writes
/// straight back through a binding to the parent's @AppStorage.
struct SettingsPopover: View {
    /// Binding to the persisted theme. Writing here updates the parent's
    /// @AppStorage and therefore every themed view in the tree.
    @Binding var theme: AppTheme

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings")
                .font(.system(size: 13, weight: .semibold, design: .rounded))

            themeGrid

            Divider()

            HStack {
                Text("Refresh interval")
                    .font(.system(size: 11, design: .rounded))
                Spacer()
                Text("30s")
                    .font(.system(size: 11, design: .rounded))
                    .foregroundColor(.secondary)
            }

            Divider()

            Button(action: openConfigFile) {
                Label("Open Config File", systemImage: "doc.text")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)
        }
        .padding(14)
        .frame(width: 320)
    }

    // MARK: - Theme grid

    private var themeGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Theme")
                .font(.system(size: 11, weight: .medium, design: .rounded))
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(AppTheme.allCases) { t in
                    themeCell(for: t)
                }
            }
        }
    }

    private func themeCell(for t: AppTheme) -> some View {
        Button {
            withAnimation(.easeInOut(duration: 0.30)) { theme = t }
        } label: {
            HStack(spacing: 8) {
                ThemeSwatch(theme: t, isSelected: theme == t)
                VStack(alignment: .leading, spacing: 1) {
                    Text(t.displayName)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundColor(theme == t ? .primary : .secondary)
                    Text(t.tagline)
                        .font(.system(size: 8, design: .rounded))
                        .foregroundColor(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .stroke(theme == t ? t.colors.secondary : Color.clear, lineWidth: 1.5)
            )
        }
        .buttonStyle(.borderless)
    }

    // MARK: - Actions

    private func openConfigFile() {
        let configPath = NSHomeDirectory() + "/.tokmeter/config.json"
        NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
    }
}

// MARK: - Swatch

/// Small preview of the theme's gradient with its icon centered — shown in
/// the settings picker. Selection is a bright ring around the swatch.
struct ThemeSwatch: View {
    let theme: AppTheme
    let isSelected: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6)
                .fill(LinearGradient(
                    colors: [theme.colors.primary, theme.colors.secondary, theme.colors.warm],
                    startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 26, height: 26)
            Image(systemName: theme.icon)
                .font(.system(size: 11, weight: .bold))
                .foregroundColor(.white)
        }
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .stroke(isSelected ? theme.colors.accent : Color.white.opacity(0.2), lineWidth: 1.5)
        )
    }
}
