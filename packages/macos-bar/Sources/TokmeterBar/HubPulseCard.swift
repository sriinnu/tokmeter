// HubPulseCard.swift — "Today's pulse" panel + supporting PulseTile.
//
// Surfaces the same signals as SignalsRibbon (burn / cache / compaction /
// reasoning) but with their raw underlying numbers visible, plus a full
// 5-hour billing window strip with progress bar — the dig-in for what the
// bar chip flashes.

import SwiftUI

/// "Today's pulse" panel — accepts the live signals and renders 4 mini-tiles
/// for burn/cache/compaction/reasoning plus a wide billing-window strip when
/// a Claude block is active. Inactive tiles render dimmed (Apple Fitness
/// idiom) so the layout stays stable as signals come and go.
struct HubPulseCard: View {
    let signals: StatbarSignals
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 14) {
                Text("Today's pulse")
                    .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                HStack(spacing: 10) {
                    // "—" for inactive numeric tiles instead of "0%" — "0%"
                    // reads as "cache failed today / reasoning crashed" when
                    // truth is "no data flowed through that path." Em-dash is
                    // the honest signal: nothing to report, not a failure.
                    let burnActive = signals.burnRate.recordsInWindow > 0
                    let cacheActive = signals.cacheHitToday.cacheReadTokens
                        + signals.cacheHitToday.inputTokens > 0
                    let compActive = signals.compactionToday.events > 0
                    let reasonActive = signals.reasoningToday.records > 0
                    PulseTile(
                        label: "Burn rate",
                        value: burnActive
                            ? Fmt.costPerHour(signals.burnRate.costPerHour)
                            : "—",
                        sub: burnActive
                            ? "\(signals.burnRate.recordsInWindow) record(s) · "
                                + "\(signals.burnRate.windowMinutes)m"
                            : "no activity yet",
                        icon: "flame.fill",
                        accent: c.warm,
                        active: burnActive,
                        theme: theme
                    )
                    PulseTile(
                        label: "Cache hit",
                        value: cacheActive
                            ? "\(Int(signals.cacheHitToday.rate * 100))%"
                            : "—",
                        sub: cacheActive
                            ? "\(Fmt.number(signals.cacheHitToday.cacheReadTokens)) cached / "
                                + "\(Fmt.number(signals.cacheHitToday.inputTokens)) fresh"
                            : "no cache-eligible calls",
                        icon: "tray.full.fill",
                        accent: c.secondary,
                        active: cacheActive,
                        theme: theme
                    )
                    PulseTile(
                        label: "Compaction",
                        value: compActive
                            ? "\(Int(signals.compactionToday.share * 100))%"
                            : "—",
                        sub: compActive
                            ? String(format: "$%.2f · %d run(s)",
                                     signals.compactionToday.cost,
                                     signals.compactionToday.events)
                            : "no /compact today",
                        icon: "rectangle.compress.vertical",
                        accent: c.tertiary,
                        active: compActive,
                        theme: theme
                    )
                    PulseTile(
                        label: "Reasoning",
                        value: reasonActive
                            ? "\(Int(signals.reasoningToday.share * 100))%"
                            : "—",
                        sub: reasonActive
                            ? "\(Fmt.number(signals.reasoningToday.tokens)) of "
                              + "\(Fmt.number(signals.reasoningToday.outputTokens)) output"
                            : "no reasoning today",
                        icon: "brain",
                        accent: c.accent,
                        active: reasonActive,
                        theme: theme
                    )
                    let subagentActive = signals.subagentToday.records > 0
                    PulseTile(
                        label: "Subagents",
                        value: subagentActive
                            ? "\(Int(signals.subagentToday.share * 100))%"
                            : "—",
                        sub: subagentActive
                            ? String(format: "$%.2f · %d turn(s)",
                                     signals.subagentToday.cost,
                                     signals.subagentToday.records)
                            : "no subagent work",
                        icon: "person.2.fill",
                        accent: c.highlight,
                        active: subagentActive,
                        theme: theme
                    )
                }
                if let billing = signals.billingWindow {
                    BillingStrip(window: billing, theme: theme)
                }
            }
        }
    }

    static func hasContent(_ s: StatbarSignals) -> Bool {
        if s.burnRate.recordsInWindow > 0 { return true }
        if s.cacheHitToday.cacheReadTokens + s.cacheHitToday.inputTokens > 0 { return true }
        if s.compactionToday.events > 0 { return true }
        if s.reasoningToday.records > 0 { return true }
        if s.subagentToday.records > 0 { return true }
        if s.billingWindow != nil { return true }
        return false
    }
}

/// One signal in the "Today's pulse" card — small tile, sub-line carries the
/// raw numbers. `active == false` dims the tile so signals that haven't
/// fired today still occupy their slot (Apple Fitness ring-closed idiom).
struct PulseTile: View {
    let label: String
    let value: String
    let sub: String
    let icon: String
    let accent: Color
    let active: Bool
    let theme: AppTheme

    @State private var hovered = false

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: icon)
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(active ? accent : bg.secondaryTextColor.opacity(0.5))
                    Text(label.uppercased())
                        .font(.system(size: 9, weight: .semibold, design: theme.fonts.labelDesign))
                        .tracking(1.2)
                        .foregroundColor(bg.secondaryTextColor)
                    Spacer(minLength: 0)
                }
                Text(value)
                    .font(.system(size: 18, weight: .bold, design: theme.fonts.valueDesign))
                    // 0.55 not 0.45: below ~0.5 it tips from "inactive" to
                    // "broken"; Apple Fitness dims to ~0.6 with a soft gray.
                    .foregroundColor(active
                        ? bg.primaryTextColor
                        : bg.primaryTextColor.opacity(0.55))
                    .contentTransition(.numericText())
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(sub)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor.opacity(active ? 1 : 0.70))
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
        }
        .scaleEffect(hovered ? 1.015 : 1.0)
        .animation(.spring(response: 0.30, dampingFraction: 0.72), value: hovered)
        .onHover { hovered = $0 }
    }
}

/// Wide strip showing the current Claude 5h billing block: time + cost +
/// turns + progress bar all visible at once. Thresholds match Apple's
/// time-bounded-resource idiom (Screen Time / battery): amber 75%, red 90%.
struct BillingStrip: View {
    let window: BillingWindow
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Image(systemName: "timer")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(accent)
                Text("Claude billing window")
                    .font(.system(size: 12, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("block #\(window.blockNumber) · \(Int(window.elapsedPct))% elapsed")
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                Spacer()
                Text(formatRemainingLong(window.remainingSec) + " left")
                    .font(.system(size: 12, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(accent)
                Text("·")
                    .foregroundColor(bg.secondaryTextColor.opacity(0.4))
                Text(String(format: "$%.2f", window.cost))
                    .font(.system(size: 12, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("· \(window.records) turn(s)")
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 3)
                        .fill(bg.secondaryTextColor.opacity(0.12))
                        .frame(height: 5)
                    RoundedRectangle(cornerRadius: 3)
                        .fill(accent)
                        .frame(
                            width: max(2, geo.size.width * window.elapsedPct / 100),
                            height: 5
                        )
                        .animation(
                            .spring(response: 0.6, dampingFraction: 0.85),
                            value: window.elapsedPct
                        )
                }
            }
            .frame(height: 5)
        }
        .padding(.top, 4)
    }

    private var accent: Color {
        if window.elapsedPct >= 90 { return Color.tokDanger }
        if window.elapsedPct >= 75 { return Color.tokWarning }
        return c.secondary
    }

    private func formatRemainingLong(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 && m > 0 { return "\(h)h \(m)m" }
        if h > 0 { return "\(h)h" }
        return "\(m)m"
    }
}
