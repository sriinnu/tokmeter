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
//   - Footer actions: Reset to defaults · Open config.json

import AppKit
import SwiftUI

struct HubSettingsPanel: View {
    @ObservedObject var loader: TokmeterLoader
    @Binding var theme: AppTheme

    @StateObject private var store = HubConfigStore.shared

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 20) {
                header.cascadeIn(delay: 0.04)
                themeSection.cascadeIn(delay: 0.12)
                refreshSection.cascadeIn(delay: 0.22)
                pricingSection.cascadeIn(delay: 0.30)
                cliDefaultsSection.cascadeIn(delay: 0.38)
                alertsSection.cascadeIn(delay: 0.46)
                footerActions.cascadeIn(delay: 0.54)
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
                        withAnimation(.spring(response: 0.50, dampingFraction: 0.65)) {
                            theme = t
                        }
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

    // MARK: - Footer actions

    private var footerActions: some View {
        HStack(spacing: 10) {
            HubSettingsActionButton(
                icon: "arrow.counterclockwise",
                label: "Reset to defaults",
                theme: theme,
                tint: .warning
            ) {
                withAnimation(.spring(response: 0.45, dampingFraction: 0.65)) {
                    store.reset()
                }
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

// ─── Stepper row ─────────────────────────────────────────────────────────

struct HubStepperRow: View {
    let label: String
    let helpText: String
    @Binding var value: Int
    let range: ClosedRange<Int>
    let step: Int
    let suffix: String
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(helpText)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            HStack(spacing: 6) {
                HubStepButton(icon: "minus", theme: theme, disabled: value <= range.lowerBound) {
                    let next = max(range.lowerBound, value - step)
                    if next != value {
                        withAnimation(.spring(response: 0.30, dampingFraction: 0.60)) { value = next }
                    }
                }
                Text("\(value)\(suffix)")
                    .font(.system(size: 13, weight: .bold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .frame(minWidth: 44)
                    .contentTransition(.numericText())
                HubStepButton(icon: "plus", theme: theme, disabled: value >= range.upperBound) {
                    let next = min(range.upperBound, value + step)
                    if next != value {
                        withAnimation(.spring(response: 0.30, dampingFraction: 0.60)) { value = next }
                    }
                }
            }
        }
    }
}

struct HubStepButton: View {
    let icon: String
    let theme: AppTheme
    let disabled: Bool
    let action: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: action) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(disabled ? bg.secondaryTextColor.opacity(0.4) : c.accent)
                .frame(width: 22, height: 22)
                .background(
                    Circle()
                        .fill(hovered && !disabled ? c.accent.opacity(0.18) : c.accent.opacity(0.08))
                        .overlay(Circle().stroke(c.accent.opacity(0.35), lineWidth: 0.8))
                )
                .scaleEffect(hovered && !disabled ? 1.08 : 1.0)
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .onHover { hovered = !disabled && $0 }
        .animation(.spring(response: 0.28, dampingFraction: 0.60), value: hovered)
    }
}

// ─── Picker row (enum-backed) ────────────────────────────────────────────

struct HubPickerRow<Option: Identifiable & CaseIterable & RawRepresentable & Hashable>: View
where Option.RawValue == String, Option.AllCases: RandomAccessCollection {
    let label: String
    let helpText: String
    @Binding var selection: Option
    let options: Option.AllCases
    let theme: AppTheme

    /// Each option needs a human label — we read it off a `label` property
    /// if the type has one. To stay generic, the caller types are
    /// `ConfigDefaultRange` / `ConfigDefaultSort` which both expose `label`.
    let labelProvider: ((Option) -> String)?

    init(
        label: String,
        helpText: String,
        selection: Binding<Option>,
        options: Option.AllCases,
        theme: AppTheme,
        labelProvider: ((Option) -> String)? = nil
    ) {
        self.label = label
        self.helpText = helpText
        self._selection = selection
        self.options = options
        self.theme = theme
        self.labelProvider = labelProvider
    }

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private func humanLabel(for o: Option) -> String {
        if let p = labelProvider { return p(o) }
        if let dr = o as? ConfigDefaultRange { return dr.label }
        if let ds = o as? ConfigDefaultSort { return ds.label }
        return o.rawValue.capitalized
    }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(helpText)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Picker("", selection: $selection) {
                ForEach(Array(options), id: \.id) { opt in
                    Text(humanLabel(for: opt)).tag(opt)
                }
            }
            .pickerStyle(.menu)
            .labelsHidden()
            .frame(minWidth: 140)
            .tint(c.accent)
        }
    }
}

// ─── Threshold row ───────────────────────────────────────────────────────

struct HubThresholdRow: View {
    let label: String
    let helpText: String
    @Binding var value: Double?
    let theme: AppTheme

    @State private var text: String = ""

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(helpText)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            HStack(spacing: 4) {
                Text("$")
                    .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.secondaryTextColor)
                TextField("off", text: $text)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 80)
                    .font(.system(size: 12, design: theme.fonts.valueDesign))
                    .onAppear {
                        text = value.map { String(format: "%.2f", $0) } ?? ""
                    }
                    .onSubmit { commit() }
                    .onExitCommand { commit() }
            }
        }
    }

    private func commit() {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty || trimmed.lowercased() == "off" {
            value = nil
            text = ""
            return
        }
        if let n = Double(trimmed), n > 0 {
            value = n
            text = String(format: "%.2f", n)
        } else {
            // Reject — reset text to the last valid value
            text = value.map { String(format: "%.2f", $0) } ?? ""
        }
    }
}

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
