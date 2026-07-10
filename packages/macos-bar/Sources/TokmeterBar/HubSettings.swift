// HubSettings.swift — the Hub's Settings panel.
//
// Reads and writes ~/.tokmeter/config.json via HubConfigStore. Every edit
// takes effect immediately: the bar's refresh timer reacts to
// bar.refreshSeconds via a Combine subscription; the CLI's cli.defaultRange
// is read fresh every invocation. No app restart required.
//
// Layout:
//   - Theme section (8-theme picker, same lineup as the bar's popover)
//   - Refresh cadence section (bar + daemon steppers, live preview of seconds)
//   - CLI defaults section (range + sort pickers)
//   - Alerts section (daily cost threshold)
//   - Integrations section (Antigravity live polling, off by default)
//   - Footer actions: Reset to defaults · Open config.json

import AppKit
import SwiftUI

struct HubSettingsPanel: View {
    @ObservedObject var loader: TokmeterLoader
    @Binding var theme: AppTheme

    @StateObject private var store = HubConfigStore.shared

    // Deep rescan is a mutation (rewrites sealed relay days), so it's gated
    // behind an explicit confirm — never a one-tap surprise.
    @State private var showRescanConfirm = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 20) {
                header.cascadeIn(delay: 0.04)
                themeSection.cascadeIn(delay: 0.12)
                refreshSection.cascadeIn(delay: 0.22)
                menubarSection.cascadeIn(delay: 0.30)
                pricingSection.cascadeIn(delay: 0.38)
                dataSection.cascadeIn(delay: 0.42)
                cliDefaultsSection.cascadeIn(delay: 0.46)
                alertsSection.cascadeIn(delay: 0.54)
                integrationsSection.cascadeIn(delay: 0.58)
                footerActions.cascadeIn(delay: 0.62)
            }
            .padding(28)
        }
        .onAppear { store.reload() }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Settings")
                .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("Edits save to ~/.tokmeter/config.json. Takes effect instantly.")
                .font(.system(size: 12, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }

    // MARK: - Theme

    private var themeSection: some View {
        HubSettingsSection(title: "Theme", icon: "paintpalette.fill", theme: theme) {
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                ForEach(AppTheme.allCases) { t in
                    HubThemePickerCell(
                        candidate: t,
                        isSelected: theme == t,
                        currentTheme: theme
                    ) {
                        // Theme change re-renders the whole Hub; animating that
                        // structural change re-enters the constraint pass. Instant.
                        theme = t
                    }
                }
            }
        }
    }

    // MARK: - Refresh cadence

    private var refreshSection: some View {
        HubSettingsSection(title: "Refresh cadence", icon: "arrow.clockwise", theme: theme) {
            VStack(alignment: .leading, spacing: 14) {
                HubStepperRow(
                    label: "Bar refresh",
                    helpText: "Seconds between menubar fetches. The timer restarts instantly.",
                    value: Binding(
                        get: { store.config.bar.refreshSeconds },
                        set: { v in store.update { $0.bar.refreshSeconds = v } }
                    ),
                    range: 5...3600,
                    step: 5,
                    suffix: "s",
                    theme: theme
                )
                HubStepperRow(
                    label: "Daemon scan",
                    helpText: "Seconds between daemon rescans of session logs. (Advisory — takes effect on next daemon start.)",
                    value: Binding(
                        get: { store.config.daemon.scanIntervalSeconds },
                        set: { v in store.update { $0.daemon.scanIntervalSeconds = v } }
                    ),
                    range: 10...3600,
                    step: 10,
                    suffix: "s",
                    theme: theme
                )
            }
        }
    }

    // MARK: - CLI defaults

    private var menubarSection: some View {
        HubSettingsSection(title: "Menubar", icon: "menubar.rectangle", theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HubPickerRow(
                    label: "Live color source",
                    helpText: "Tints the menubar green→yellow→orange→red. Context = worst live "
                        + "context-window fill (needs a provider that reports one). Block = "
                        + "Anthropic 5-hour billing block. Budget = today's cost vs the daily "
                        + "threshold below. Off = no coloring.",
                    selection: Binding(
                        get: { store.config.colorSource },
                        set: { v in store.update { $0.bar.menubarColorSource = v } }
                    ),
                    options: MenubarColorSource.allCases,
                    theme: theme
                )
            }
        }
    }

    private var cliDefaultsSection: some View {
        HubSettingsSection(title: "CLI defaults", icon: "terminal.fill", theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HubPickerRow(
                    label: "Default time window",
                    helpText: "Used by `tokmeter` when no --today/--week/... flag is passed.",
                    selection: Binding(
                        get: { store.config.cli.defaultRange },
                        set: { v in store.update { $0.cli.defaultRange = v } }
                    ),
                    options: ConfigDefaultRange.allCases,
                    theme: theme
                )
                HubPickerRow(
                    label: "Default sort",
                    helpText: "Default ordering for tables that rank projects/models.",
                    selection: Binding(
                        get: { store.config.cli.defaultSort },
                        set: { v in store.update { $0.cli.defaultSort = v } }
                    ),
                    options: ConfigDefaultSort.allCases,
                    theme: theme
                )
            }
        }
    }

    // MARK: - Pricing & auto-fetch
    //
    // Single source of truth for the pricing freshness + daily-cron state is
    // TokmeterLoader (which mirrors /api/pricing-status + /api/cron-status,
    // or computes them from disk when the daemon is offline). The popover's
    // SettingsPopover renders the same data in compact form.

    // MARK: - Data (deep rescan)

    private var dataSection: some View {
        HubSettingsSection(
            title: "Data",
            icon: "arrow.triangle.2.circlepath",
            theme: theme
        ) {
            VStack(alignment: .leading, spacing: 14) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Deep rescan")
                            .font(.system(size: 13, weight: .medium, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.primaryTextColor)
                        Text(
                            "Rebuild the last 30 days from raw logs and backfill pace history. Rewrites those sealed days, runs in the background, and leaves older history untouched. The main panel's Refresh stays a quick, today-only read."
                        )
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(4)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button(action: { showRescanConfirm = true }) {
                        HStack(spacing: 4) {
                            if loader.isRescanning {
                                ProgressView().scaleEffect(0.6).frame(width: 12, height: 12)
                            }
                            Text(loader.isRescanning ? "Starting…" : "Deep rescan")
                        }
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(loader.isRescanning)
                    .confirmationDialog(
                        "Rebuild the last 30 days from raw logs?",
                        isPresented: $showRescanConfirm,
                        titleVisibility: .visible
                    ) {
                        Button("Rebuild 30 days") { Task { await loader.deepRescan() } }
                        Button("Cancel", role: .cancel) {}
                    } message: {
                        Text(
                            "This re-derives and overwrites the last 30 sealed days (backfilling pace). Older history is left as-is. Runs in the background."
                        )
                    }
                }
                if loader.rescanStartedNotice {
                    Text(
                        "Rescan started — history is rebuilding in the background. Pace history fills in shortly."
                    )
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(.green)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let err = loader.rescanError {
                    Text(err)
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                        .foregroundColor(.red)
                        .lineLimit(2)
                }
            }
        }
    }

    private var pricingSection: some View {
        HubSettingsSection(
            title: "Pricing & auto-fetch",
            icon: "dollarsign.arrow.circlepath",
            theme: theme
        ) {
            VStack(alignment: .leading, spacing: 14) {
                pricingRow
                if let cron = loader.cronStatus {
                    Divider().background(bg.secondaryTextColor.opacity(0.18))
                    cronRow(cron)
                }
                if let err = loader.pricingRefreshError ?? loader.cronInstallError {
                    Text(err)
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                        .foregroundColor(.red)
                        .lineLimit(3)
                }
            }
        }
    }

    private var pricingRow: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                Text("Pricing data")
                    .font(.system(size: 13, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(pricingFreshnessLine)
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            Spacer()
            Button(action: { Task { await loader.refreshPricing() } }) {
                HStack(spacing: 4) {
                    if loader.isRefreshingPricing {
                        ProgressView().scaleEffect(0.6).frame(width: 12, height: 12)
                    }
                    Text(
                        loader.isRefreshingPricing
                            ? "Updating…"
                            : (isPricingStale ? "Force refresh" : "Update now")
                    )
                }
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(loader.isRefreshingPricing)
        }
    }

    private func cronRow(_ cron: CronStatus) -> some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Image(
                        systemName: cron.installed
                            ? "clock.badge.checkmark"
                            : "clock.badge.exclamationmark"
                    )
                    .font(.system(size: 12))
                    .foregroundColor(cron.installed ? .green : .orange)
                    Text(
                        cron.installed
                            ? "Daily auto-fetch installed"
                            : "Daily auto-fetch not installed"
                    )
                    .font(.system(size: 13, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.primaryTextColor)
                }
                Text(cronDetailLine(cron))
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
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
                        ProgressView().scaleEffect(0.6).frame(width: 12, height: 12)
                    }
                    Text(cron.installed ? "Disable" : "Install")
                }
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(loader.isInstallingCron)
        }
    }

    private var pricingFreshnessLine: String {
        guard loader.pricingMtime > 0 else {
            return "Never fetched — kosha registry missing."
        }
        let seconds = Date().timeIntervalSince1970 - loader.pricingMtime / 1000.0
        if seconds < 60 { return "Just fetched." }
        if seconds < 3600 { return "Fetched \(Int(seconds / 60))m ago." }
        if seconds < 86_400 { return "Fetched \(Int(seconds / 3600))h ago." }
        let days = Int(seconds / 86_400)
        return days == 1 ? "Fetched 1 day ago." : "Fetched \(days) days ago."
    }

    private var isPricingStale: Bool {
        guard loader.pricingMtime > 0 else { return true }
        return Date().timeIntervalSince1970 - loader.pricingMtime / 1000.0 > 86_400
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

    // MARK: - Alerts

    private var alertsSection: some View {
        HubSettingsSection(title: "Alerts", icon: "bell.fill", theme: theme) {
            HubThresholdRow(
                label: "Daily cost threshold",
                helpText: "Flag any day that exceeds this USD amount. Empty = disabled.",
                value: Binding(
                    get: { store.config.alerts.dailyCostThreshold },
                    set: { v in store.update { $0.alerts.dailyCostThreshold = v } }
                ),
                theme: theme
            )
        }
    }

    // MARK: - Integrations

    private var integrationsSection: some View {
        HubSettingsSection(title: "Integrations", icon: "bolt.horizontal.circle.fill", theme: theme) {
            VStack(alignment: .leading, spacing: 14) {
                HubToggleRow(
                    label: "Antigravity live credit polling",
                    helpText: "Off by default. When on, the daemon periodically reads a CSRF token "
                        + "out of Antigravity's own running process and calls its undocumented "
                        + "internal status endpoint for live model + credit usage. Same technique "
                        + "the community antigravity-panel extension uses, but an internal channel "
                        + "Antigravity didn't publish for this — an unsupervised, indefinite "
                        + "background job, so it's opt-in only.",
                    isOn: Binding(
                        get: { store.config.daemon.antigravityLivePolling },
                        set: { v in store.update { $0.daemon.antigravityLivePolling = v } }
                    ),
                    theme: theme
                )

                Divider().opacity(0.3)

                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Fetch now")
                            .font(.system(size: 13, weight: .medium, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.primaryTextColor)
                        Text(
                            "One-shot manual read — works whether or not the polling toggle above is on. Same underlying call, but a single explicit request instead of a standing background job."
                        )
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer()
                    Button(action: { Task { await loader.fetchAntigravityLiveNow() } }) {
                        HStack(spacing: 4) {
                            if loader.isFetchingAntigravityLiveNow {
                                ProgressView().scaleEffect(0.6).frame(width: 12, height: 12)
                            }
                            Text(loader.isFetchingAntigravityLiveNow ? "Fetching…" : "Fetch now")
                        }
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(loader.isFetchingAntigravityLiveNow)
                }

                if let err = loader.antigravityLiveFetchError {
                    Text(err)
                        .font(.system(size: 11, design: theme.fonts.bodyDesign))
                        .foregroundColor(.red)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }

                antigravityLiveSummary
            }
        }
    }

    /// Reflects whatever the last fetch (manual or background) captured.
    /// Distinguishes "never fetched" from "fetched, Antigravity wasn't
    /// running" — both are legitimate nil states, not errors, but a user
    /// staring at a blank panel needs to know which one they're looking at.
    @ViewBuilder
    private var antigravityLiveSummary: some View {
        if let snapshot = loader.antigravityLive?.latestSnapshot {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 12) {
                    Text("\(snapshot.availablePromptCredits) prompt credits")
                        .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Text("\(snapshot.availableFlowCredits) flow credits")
                        .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    Text(relativeTime(fromMs: snapshot.timestamp))
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                }
                if !snapshot.models.isEmpty {
                    Text(snapshot.models.map(\.label).joined(separator: " · "))
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(2)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let used = loader.antigravityLive?.creditsUsedToday,
                   used.promptCreditsUsed > 0 || used.flowCreditsUsed > 0 {
                    Text("\(used.promptCreditsUsed) prompt + \(used.flowCreditsUsed) flow credits used today")
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(c.accent)
                }
            }
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 8).fill(bg.secondaryTextColor.opacity(0.06)))
        } else {
            Text("Not fetched yet — turn on polling above, or tap Fetch now.")
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }

    private func relativeTime(fromMs ms: Double) -> String {
        let date = Date(timeIntervalSince1970: ms / 1000)
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .abbreviated
        return formatter.localizedString(for: date, relativeTo: Date())
    }

    // MARK: - Footer actions

    private var footerActions: some View {
        HStack(spacing: 10) {
            HubSettingsActionButton(
                icon: "arrow.counterclockwise",
                label: "Reset to defaults",
                theme: theme,
                tint: .warning
            ) {
                store.reset()
            }
            HubSettingsActionButton(
                icon: "doc.text",
                label: "Open config.json",
                theme: theme,
                tint: .accent
            ) {
                let path = HubConfigStore.filePath
                // Create the file if it doesn't exist yet — opening `open`
                // on a missing path fails silently otherwise.
                if !FileManager.default.fileExists(atPath: path) {
                    store.update { _ in /* trigger save with current values */ }
                }
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
            }
            Spacer()
        }
    }
}

// ─── Section wrapper ─────────────────────────────────────────────────────

struct HubSettingsSection<Content: View>: View {
    let title: String
    let icon: String
    let theme: AppTheme
    let content: () -> Content

    init(title: String, icon: String, theme: AppTheme,
         @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.icon = icon
        self.theme = theme
        self.content = content
    }

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 8) {
                    Image(systemName: icon)
                        .font(.system(size: 12, weight: .semibold))
                        .foregroundColor(c.accent)
                    Text(title)
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                }
                content()
            }
        }
    }
}

