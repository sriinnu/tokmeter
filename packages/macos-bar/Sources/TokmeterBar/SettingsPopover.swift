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
    @ObservedObject var loader: TokmeterLoader

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

            pricingRefreshRow

            Divider()

            Button(action: openWebPanel) {
                Label("Open web dashboard", systemImage: "safari")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)

            Button(action: openConfigFile) {
                Label("Open Config File", systemImage: "doc.text")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)
        }
        .padding(14)
        .frame(width: 320)
    }

    // MARK: - Pricing refresh row

    private var pricingRefreshRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pricing data")
                        .font(.system(size: 11, design: .rounded))
                    Text("Pull latest model prices from kosha")
                        .font(.system(size: 9, design: .rounded))
                        .foregroundColor(.secondary)
                }
                Spacer()
                Button(action: { Task { await loader.refreshPricing() } }) {
                    HStack(spacing: 4) {
                        if loader.isRefreshingPricing {
                            ProgressView()
                                .scaleEffect(0.6)
                                .frame(width: 12, height: 12)
                        }
                        Text(loader.isRefreshingPricing ? "Updating…" : "Update now")
                    }
                    .font(.system(size: 10, design: .rounded))
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
                .disabled(loader.isRefreshingPricing)
            }
            if let err = loader.pricingRefreshError {
                Text(err)
                    .font(.system(size: 9, design: .rounded))
                    .foregroundColor(.red)
                    .lineLimit(2)
            }
        }
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
        ThemePickerCell(theme: t, isSelected: theme == t) {
            // Spring switch — the parent's `.animation(value: theme)` modifier
            // catches this and propagates a smooth retint across the tree.
            withAnimation(.spring(response: 0.50, dampingFraction: 0.78)) { theme = t }
        }
    }

    // MARK: - Actions

    private func openWebPanel() {
        if let url = URL(string: "http://localhost:3000") {
            NSWorkspace.shared.open(url)
        }
    }

    /// Open the user's `~/.tokmeter/config.json` in the default editor. If
    /// that path has been replaced with a symlink escaping ~/.tokmeter/
    /// (e.g. to `~/.ssh/id_rsa`), we silently refuse rather than leak the
    /// target file into an editor. Resolved via `realpath(3)`.
    private func openConfigFile() {
        let tokmeterDir = NSHomeDirectory() + "/.tokmeter"
        let configPath = tokmeterDir + "/config.json"

        // No file yet — nothing to open, and nothing to spoof.
        guard FileManager.default.fileExists(atPath: configPath) else {
            NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
            return
        }

        // Canonicalize via realpath, which follows all symlinks. If the
        // target escapes our own directory, bail — an attacker with write
        // access to ~/.tokmeter/ must not be able to leak anything else.
        var resolved = [CChar](repeating: 0, count: Int(PATH_MAX))
        guard realpath(configPath, &resolved) != nil else {
            NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
            return
        }
        let resolvedStr = String(cString: resolved)
        guard resolvedStr.hasPrefix(tokmeterDir + "/") else { return }
        NSWorkspace.shared.open(URL(fileURLWithPath: resolvedStr))
    }
}

// MARK: - Picker cell + swatch

/// One row in the theme picker grid: swatch + name + tagline. Has its own
/// hover/select animation so only the touched cell re-renders.
struct ThemePickerCell: View {
    let theme: AppTheme
    let isSelected: Bool
    let onTap: () -> Void

    @State private var hovered: Bool = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                ThemeSwatch(theme: theme, isSelected: isSelected)
                VStack(alignment: .leading, spacing: 1) {
                    Text(theme.displayName)
                        .font(.system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundColor(isSelected ? .primary : .secondary)
                    Text(theme.tagline)
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
                    .fill(hovered ? Color.primary.opacity(0.06) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .stroke(isSelected ? theme.colors.secondary : Color.clear, lineWidth: 1.5)
                    )
            )
            // Subtle hover lift — same idiom as the KPI cards so the whole app
            // feels consistent.
            .scaleEffect(hovered ? 1.04 : 1.0)
            .offset(y: hovered ? -1 : 0)
            .animation(.spring(response: 0.30, dampingFraction: 0.75), value: hovered)
        }
        .buttonStyle(.borderless)
        .onHover { hovered = $0 }
    }
}

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
