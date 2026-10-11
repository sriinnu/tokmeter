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
    @ObservedObject private var configStore = HubConfigStore.shared
    @ObservedObject private var dashboard = WebDashboardController.shared

    private var paper: Bool { theme == .paper }
    private var mode: BackgroundMode { theme.backgroundMode }

    /// Body type follows the theme: serif on Paper, rounded elsewhere.
    private func f(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: paper ? .serif : .rounded)
    }

    @ViewBuilder
    private var rule: some View {
        if paper { InkRule(weight: 0.5) } else { Divider() }
    }

    @ViewBuilder
    private func sectionLabel(_ text: String) -> some View {
        if paper {
            Kicker(text: text, inverted: true)
        } else {
            Text(text).font(.system(size: 11, weight: .medium, design: .rounded))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            if paper {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Settings")
                        .font(Broadsheet.display(22))
                        .foregroundColor(Broadsheet.ink)
                    DoubleRule()
                }
            } else {
                Text("Settings")
                    .font(.system(size: 13, weight: .semibold, design: .rounded))
            }

            themeGrid

            rule

            chartStyleRow

            rule

            HStack {
                Text("Refresh interval")
                    .font(f(11))
                Spacer()
                Text(Fmt.interval(configStore.config.bar.refreshSeconds))
                    .font(paper ? Broadsheet.display(12, weight: .bold).monospacedDigit() : f(11))
                    .foregroundColor(paper ? Broadsheet.ink : .secondary)
            }

            rule

            pricingRefreshRow

            rule

            Button { Task { await dashboard.open() } } label: {
                Label(dashboard.isStarting ? "Starting dashboard…" : "Open web dashboard", systemImage: "safari")
                    .font(f(11))
            }
            .settingsLinkStyle(paper: paper)

            if dashboard.isStarting || dashboard.isRunning {
                Button(dashboard.isStarting ? "Cancel dashboard startup" : "Stop web dashboard") {
                    dashboard.stop()
                }
                .font(f(11))
                .settingsLinkStyle(paper: paper)
            }
            if let error = dashboard.error {
                Text(error).font(.system(size: 11)).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            } else if dashboard.isRunning {
                Text(dashboard.notice ?? "Running at \(dashboard.url.absoluteString)")
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Button(action: openConfigFile) {
                Label("Open Config File", systemImage: "doc.text")
                    .font(f(11))
            }
            .settingsLinkStyle(paper: paper)
        }
        .tint(paper ? Broadsheet.ink : theme.colors.accent)
        .foregroundStyle(mode.primaryTextColor)
        .padding(14)
        .frame(width: 320)
        // The sheet is its own window: without these it falls back to the
        // system's material and appearance (a dark grey sheet over Paper).
        .environment(\.colorScheme, mode.isLight ? .light : .dark)
        .presentationBackground { surface }
    }

    @ViewBuilder
    private var surface: some View {
        if mode.usesMaterial {
            ZStack { Rectangle().fill(.regularMaterial); mode.surfaceColor }
        } else {
            mode.surfaceColor
        }
    }

    // MARK: - 7-day chart style row

    /// Segmented line/bars/area picker for the popover's LAST 7 DAYS chart.
    /// Writes through HubConfigStore so the choice persists in config.json
    /// and survives restarts (and cross-machine restores, via modifiedBy).
    private var chartStyleRow: some View {
        HStack {
            Text("7-day chart")
                .font(f(11))
            Spacer()
            if paper {
                paperChartStylePicker
            } else {
                Picker("7-day chart style", selection: Binding(
                    get: { configStore.config.chartStyle },
                    set: { style in configStore.update { $0.bar.weekChartStyle = style } }
                )) {
                    ForEach(WeekChartStyle.allCases) { s in
                        Text(s.label).tag(s)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .frame(width: 160)
            }
        }
    }

    /// Paper: the options set as type, the current one underlined in ink —
    /// the same treatment as the All / Today tabs.
    private var paperChartStylePicker: some View {
        HStack(spacing: 12) {
            ForEach(WeekChartStyle.allCases) { s in
                let on = configStore.config.chartStyle == s
                Button { configStore.update { $0.bar.weekChartStyle = s } } label: {
                    Text(s.label)
                        .font(f(11, weight: on ? .bold : .regular))
                        .foregroundColor(on ? Broadsheet.ink : Broadsheet.muted)
                        .padding(.bottom, 2)
                        .overlay(alignment: .bottom) {
                            if on { InkRule(weight: 1.5) }
                        }
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
    }

    // MARK: - Pricing refresh row

    private var pricingRefreshRow: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Pricing data")
                        .font(f(11))
                    Text(pricingFreshnessLine)
                        .font(f(9))
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
                        Text(loader.isRefreshingPricing ? "Updating…" : (isStale ? "Force refresh" : "Update now"))
                    }
                    .font(f(10))
                }
                .settingsButtonStyle(paper: paper)
                .disabled(loader.isRefreshingPricing)
            }
            if let err = loader.pricingRefreshError {
                Text(err)
                    .font(f(9))
                    .foregroundColor(.red)
                    .lineLimit(2)
            }

            // ── Daily cron status ──────────────────────────────────────
            if let cron = loader.cronStatus {
                cronStatusRow(cron)
            }
        }
    }

    /// Returns "Last fetched 2h ago" or "Never fetched" or absolute date for
    /// older fetches. Single source of truth: pricingMtime.
    private var pricingFreshnessLine: String {
        guard loader.pricingMtime > 0 else {
            return "Never fetched — price catalog missing."
        }
        let seconds = Date().timeIntervalSince1970 - loader.pricingMtime / 1000.0
        if seconds < 60 { return "Just fetched." }
        if seconds < 3600 { return "Fetched \(Int(seconds / 60))m ago." }
        if seconds < 86_400 { return "Fetched \(Int(seconds / 3600))h ago." }
        let days = Int(seconds / 86_400)
        return days == 1 ? "Fetched 1 day ago." : "Fetched \(days) days ago."
    }

    /// Anything older than 24h is considered stale — that's the same threshold
    /// used by `maybeBackgroundRefresh()` in pricing.ts.
    private var isStale: Bool {
        guard loader.pricingMtime > 0 else { return true }
        return Date().timeIntervalSince1970 - loader.pricingMtime / 1000.0 > 86_400
    }

    @ViewBuilder
    private func cronStatusRow(_ cron: CronStatus) -> some View {
        rule.padding(.top, 2)
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 4) {
                        Image(
                            systemName: cron.installed
                                ? "clock.badge.checkmark"
                                : "clock.badge.exclamationmark"
                        )
                        .font(.system(size: 10))
                        .foregroundColor(cron.installed ? theme.statusSuccess : theme.statusWarning)
                        Text(
                            cron.installed
                                ? "Daily auto-fetch installed"
                                : "Daily auto-fetch not installed"
                        )
                        .font(f(11))
                    }
                    Text(cronDetailLine(cron))
                        .font(f(9))
                        .foregroundColor(.secondary)
                        .lineLimit(2)
                }
                Spacer()
                Button(action: {
                    Task {
                        if cron.installed {
                            await loader.uninstallCron()
                        } else {
                            await loader.installCron()
                        }
                    }
                }) {
                    HStack(spacing: 4) {
                        if loader.isInstallingCron {
                            ProgressView()
                                .scaleEffect(0.6)
                                .frame(width: 12, height: 12)
                        }
                        Text(cron.installed ? "Disable" : "Install")
                    }
                    .font(f(10))
                }
                .settingsButtonStyle(paper: paper)
                .disabled(loader.isInstallingCron)
            }
            if let err = loader.cronInstallError {
                Text(err)
                    .font(f(9))
                    .foregroundColor(.red)
                    .lineLimit(2)
            }
        }
    }

    private func cronDetailLine(_ cron: CronStatus) -> String {
        if !cron.installed {
            return "Runs `tokmeter update` daily at 00:05 — keeps prices fresh while you sleep."
        }
        if cron.lastRunMtime <= 0 {
            return "Scheduled — has not run yet. Next run: tomorrow 00:05."
        }
        let seconds = Date().timeIntervalSince1970 - cron.lastRunMtime / 1000.0
        let when: String
        if seconds < 3600 { when = "\(Int(seconds / 60))m ago" }
        else if seconds < 86_400 { when = "\(Int(seconds / 3600))h ago" }
        else { when = "\(Int(seconds / 86_400))d ago" }

        if cron.lastRunOk == true { return "Last run \(when) — succeeded." }
        if cron.lastRunOk == false {
            return "Last run \(when) — FAILED. Check ~/.cache/tokmeter/daily-cron.log"
        }
        return "Last run \(when) — status unknown (log inconclusive)."
    }

    // MARK: - Theme grid

    private var themeGrid: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionLabel("Theme")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(AppTheme.allCases) { t in
                    themeCell(for: t)
                }
            }
        }
    }

    private func themeCell(for t: AppTheme) -> some View {
        ThemePickerCell(theme: t, isSelected: theme == t, host: theme) {
            // Spring switch — the parent's `.animation(value: theme)` modifier
            // catches this and propagates a smooth retint across the tree.
            withAnimation(.spring(response: 0.50, dampingFraction: 0.78)) { theme = t }
        }
    }

    // MARK: - Actions

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
    /// The theme currently applied — the cell's chrome follows it, the
    /// swatch previews `theme`.
    var host: AppTheme? = nil
    let onTap: () -> Void

    private var paper: Bool { host == .paper }

    @State private var hovered: Bool = false

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                ThemeSwatch(theme: theme, isSelected: isSelected)
                VStack(alignment: .leading, spacing: 1) {
                    Text(theme.displayName)
                        .font(paper
                              ? Broadsheet.display(12, weight: .bold)
                              : .system(size: 10, weight: .semibold, design: .rounded))
                        .foregroundColor(paper ? Broadsheet.ink : (isSelected ? .primary : .secondary))
                    Text(theme.tagline)
                        .font(paper
                              ? .system(size: 9, design: .serif).italic()
                              : .system(size: 8, design: .rounded))
                        .foregroundColor(paper ? Broadsheet.muted : .secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: paper ? 0 : 6)
                    .fill(hovered ? Color.primary.opacity(0.06) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: paper ? 0 : 6)
                            .stroke(isSelected ? (paper ? Broadsheet.ink : (host ?? theme).colors.secondary) : Color.clear,
                                    lineWidth: 1.5)
                    )
            )
            // Subtle hover lift — same idiom as the KPI cards so the whole app
            // feels consistent. Paper doesn't bounce.
            .scaleEffect(hovered && !paper ? 1.04 : 1.0)
            .offset(y: hovered && !paper ? -1 : 0)
            .animation(.spring(response: 0.30, dampingFraction: 0.75), value: hovered)
        }
        .settingsLinkStyle(paper: paper)
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

private extension View {
    /// Paper: plain ink type, no system tint. Elsewhere: borderless.
    @ViewBuilder
    func settingsLinkStyle(paper: Bool) -> some View {
        if paper {
            buttonStyle(.plain).foregroundStyle(Broadsheet.ink)
        } else {
            buttonStyle(.borderless)
        }
    }

    /// Paper: square ink-outlined button. Elsewhere: the system's mini
    /// bordered button, tinted by the sheet.
    @ViewBuilder
    func settingsButtonStyle(paper: Bool) -> some View {
        if paper {
            buttonStyle(InkOutlineButtonStyle())
        } else {
            buttonStyle(.bordered).controlSize(.mini)
        }
    }
}

/// Square, ink-outlined, uppercase-free: the broadsheet's secondary button.
struct InkOutlineButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .foregroundColor(configuration.isPressed ? Broadsheet.stock : Broadsheet.ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(configuration.isPressed ? Broadsheet.ink : Color.clear)
            .overlay(Rectangle().strokeBorder(Broadsheet.ink, lineWidth: 1))
            .contentShape(Rectangle())
    }
}
