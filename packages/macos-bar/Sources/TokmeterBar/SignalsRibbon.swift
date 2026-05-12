// SignalsRibbon.swift — thin "right now" telemetry strip below the hero.
//
//   🔥 $3.20/hr   ·   🪣 92% cache   ·   🗜 12% to compaction
//
// One row, three chips, each a different signal:
//   - burn      → dollars per hour over the last 60 min (motion indicator)
//   - cache     → % of read tokens served from cache today (efficiency)
//   - compact   → % of today's spend going to /compact overhead (hygiene)
//
// The ribbon only renders when `loader.statbarSignals` is non-nil AND there's
// meaningful data to show — no live activity OR no spend yet → hidden so the
// bar doesn't lie about a flat "$0.00/hr" being a real burn rate.
//
// Hover on any chip surfaces a tooltip explaining the math and the window.

import SwiftUI

struct SignalsRibbon: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }

    var body: some View {
        if let signals = loader.statbarSignals, shouldShow(signals) {
            HStack(spacing: 0) {
                if signals.burnRate.recordsInWindow > 0 {
                    chip(
                        icon: "flame.fill",
                        iconColor: burnColor(signals.burnRate.costPerHour),
                        text: Fmt.costPerHour(signals.burnRate.costPerHour),
                        help:
                            "Burn rate over the last \(signals.burnRate.windowMinutes) min — "
                            + "\(signals.burnRate.recordsInWindow) record(s)."
                    )
                    divider
                }
                chip(
                    icon: "tray.full.fill",
                    iconColor: cacheColor(signals.cacheHitToday.rate),
                    text: "\(Int(signals.cacheHitToday.rate * 100))%",
                    help:
                        "Cache hit rate today — cacheRead / (cacheRead + input). "
                        + "Higher is better."
                )
                if signals.compactionToday.events > 0 {
                    divider
                    chip(
                        icon: "rectangle.compress.vertical",
                        iconColor: c.tertiary,
                        text: "\(Int(signals.compactionToday.share * 100))% compact",
                        help: String(
                            format: "Compaction tax today: $%.2f across %d /compact run(s).",
                            signals.compactionToday.cost, signals.compactionToday.events
                        )
                    )
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(theme.backgroundMode.secondaryTextColor.opacity(0.06))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(
                                theme.backgroundMode.secondaryTextColor.opacity(0.10),
                                lineWidth: 0.6
                            )
                    )
            )
            .transition(.opacity.combined(with: .move(edge: .top)))
        }
    }

    // MARK: - Helpers

    /// Hide the ribbon when there's nothing meaningful — no live activity
    /// AND no cache reads AND no compaction. Avoids a row of zeros that
    /// would otherwise misrepresent "no signal" as "perfect efficiency."
    private func shouldShow(_ s: StatbarSignals) -> Bool {
        if s.burnRate.recordsInWindow > 0 { return true }
        if s.cacheHitToday.cacheReadTokens + s.cacheHitToday.inputTokens > 0 { return true }
        if s.compactionToday.events > 0 { return true }
        return false
    }

    private var divider: some View {
        Text("·")
            .font(.system(size: 11, weight: .bold))
            .foregroundColor(theme.backgroundMode.secondaryTextColor.opacity(0.5))
            .padding(.horizontal, 8)
    }

    @ViewBuilder
    private func chip(icon: String, iconColor: Color, text: String, help: String) -> some View {
        HStack(spacing: 4) {
            Image(systemName: icon)
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(iconColor)
            Text(text)
                .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.primaryTextColor.opacity(0.85))
                .lineLimit(1)
        }
        .help(help)
    }

    /// Burn-rate color: ramps from green (cold) → amber (warm) → red (hot).
    /// Thresholds are deliberately gentle — $2/hr is normal work, $10/hr is
    /// a fire-hose session, $20/hr is "are you OK".
    private func burnColor(_ costPerHour: Double) -> Color {
        if costPerHour >= 20 { return Color(red: 0.96, green: 0.42, blue: 0.42) }
        if costPerHour >= 10 { return Color(red: 0.95, green: 0.70, blue: 0.30) }
        if costPerHour >= 2  { return c.secondary }
        return Color(red: 0.13, green: 0.80, blue: 0.47)
    }

    /// Cache-hit color: green when the cache is doing its job (≥90%),
    /// amber when partial, red when something's wrong.
    private func cacheColor(_ rate: Double) -> Color {
        if rate >= 0.90 { return Color(red: 0.13, green: 0.80, blue: 0.47) }
        if rate >= 0.60 { return Color(red: 0.95, green: 0.70, blue: 0.30) }
        return Color(red: 0.96, green: 0.42, blue: 0.42)
    }
}
