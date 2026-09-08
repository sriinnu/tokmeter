// SignalsRibbon.swift — thin "right now" telemetry strip below the hero.
//
//   🔥 $3.20/hr  ·  🪣 92% cache  ·  🗜 12% compact  ·  🧠 60% reasoning  ·  ⏱ 2h12m · $4.20
//
// Chips wrap onto additional rows instead of truncating their readings:
//   - burn      → dollars per hour over the last 60 min (motion indicator)
//   - cache     → % of read tokens served from cache today (efficiency)
//   - compact   → % of today's spend going to /compact overhead (hygiene)
//   - reasoning → % of today's output tokens that are model reasoning. Only
//                 surfaces for OpenAI-style providers (Codex, GPT-5.x-codex)
//                 that separate reasoning from visible output. Tells the user
//                 "this much of your output is invisible thinking" — actionable
//                 for dropping effort:low on routine tasks.
//   - billing   → time + cost in the current Claude Pro/Max 5h billing block.
//                 Anthropic's caps live in 5h windows; running out mid-task
//                 means a wait. Only surfaces while a block is active.
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
            SignalFlowLayout() {
                if signals.burnRate.recordsInWindow > 0 {
                    burnChip(signals.burnRate)
                }
                let cacheHit = signals.cacheHitToday.canonicalRate ?? signals.cacheHitToday.rate
                let cacheMiss = signals.cacheHitToday.missRate ?? max(0, 1 - cacheHit)
                chip(
                    icon: "tray.full.fill",
                    iconColor: cacheColor(cacheHit),
                    text: "hit \(pct(cacheHit))% miss \(pct(cacheMiss))%",
                    help:
                        "Cache today — hit is cacheRead / total input; miss is uncached input / total input. "
                        + "\(signals.cacheHitToday.cacheReadTokens) cached, "
                        + "\(signals.cacheHitToday.inputTokens) missed."
                )
                if let pressure = signals.contextPressure, pressure.status != "none" {
                    chip(
                        icon: "memorychip.fill",
                        iconColor: contextColor(pressure.status),
                        text: "drag \(pct(pressure.dragShare))%",
                        help:
                            "Context drag estimate: \(pressure.reason) "
                            + "\(pressure.dragTokens) estimated drag tokens across "
                            + "\(pressure.turnCount) turn(s)."
                    )
                }
                if signals.compactionToday.events > 0 {
                    chip(
                        icon: "rectangle.compress.vertical",
                        iconColor: c.tertiary,
                        text: "comp \(Int(signals.compactionToday.share * 100))%",
                        help: String(
                            format: "Compaction tax today: $%.2f across %d /compact run(s).",
                            signals.compactionToday.cost, signals.compactionToday.events
                        )
                    )
                }
                if signals.reasoningToday.records > 0 {
                    chip(
                        icon: "brain",
                        iconColor: reasoningColor(signals.reasoningToday.share),
                        text: "think \(Int(signals.reasoningToday.share * 100))%",
                        help: String(
                            format:
                                "Reasoning today: %d of %d output tokens were model reasoning "
                                + "(%d record(s) reported it). Drop effort:low or pick a model "
                                + "without hidden thinking to cut this on routine tasks.",
                            signals.reasoningToday.tokens,
                            signals.reasoningToday.outputTokens,
                            signals.reasoningToday.records
                        )
                    )
                }
                if let billing = signals.billingWindow {
                    chip(
                        icon: "timer",
                        iconColor: billingColor(billing.elapsedPct),
                        text: formatRemaining(billing.remainingSec) + " left",
                        help: String(
                            format:
                                "Claude 5-hour billing window — block #%d, %.0f%% elapsed. "
                                + "$%.2f across %d turn(s) so far; window ends in %@.",
                            billing.blockNumber,
                            billing.elapsedPct,
                            billing.cost,
                            billing.records,
                            formatRemainingLong(billing.remainingSec)
                        )
                    )
                }
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
        if s.cacheHitToday.cacheReadTokens
            + s.cacheHitToday.inputTokens
            + (s.cacheHitToday.cacheWriteTokens ?? 0) > 0 { return true }
        if let pressure = s.contextPressure, pressure.status != "none" { return true }
        if s.compactionToday.events > 0 { return true }
        if s.reasoningToday.records > 0 { return true }
        if s.billingWindow != nil { return true }
        return false
    }

    private func pct(_ value: Double) -> Int {
        Int((max(0, min(1, value)) * 100).rounded())
    }

    /// Generic chip. Numbers in `text` roll instead of snapping thanks to
    /// `.contentTransition(.numericText())` — when the daemon's next scan
    /// shifts a percentage from 18% → 19%, the digits animate. Same Apple
    /// idiom as Stocks, Weather, and Fitness.
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
                .contentTransition(.numericText())
                .animation(.spring(response: 0.55, dampingFraction: 0.78), value: text)
        }
        .help(help)
    }

    /// Keep the small status glyph at full contrast; animated variable-color
    /// layers can dim the entire flame against Terminal's black background.
    @ViewBuilder
    private func burnChip(_ rate: BurnRate) -> some View {
        let cph = rate.costPerHour
        HStack(spacing: 4) {
            Image(systemName: "flame.fill")
                .font(.system(size: 10, weight: .semibold))
                .symbolRenderingMode(.monochrome)
                .foregroundColor(theme.burnRateColor(cph))
            Text(Fmt.costPerHour(cph))
                .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.primaryTextColor.opacity(0.85))
                .lineLimit(1)
                .contentTransition(.numericText(value: cph))
                .animation(.spring(response: 0.55, dampingFraction: 0.78), value: cph)
        }
        .help(
            "Burn rate over the last \(rate.windowMinutes) min — "
            + "\(rate.recordsInWindow) record(s)."
        )
    }

    /// Cache-hit color: green when the cache is doing its job (≥90%),
    /// amber when partial, red when something's wrong.
    private func cacheColor(_ rate: Double) -> Color {
        if rate >= 0.90 { return theme.statusSuccess }
        if rate >= 0.60 { return theme.statusWarning }
        return theme.statusDanger
    }

    private func contextColor(_ status: String) -> Color {
        switch status {
        case "critical":
            return theme.statusDanger
        case "high":
            return theme.statusWarning
        case "medium":
            return c.tertiary
        default:
            return theme.backgroundMode.secondaryTextColor
        }
    }

    /// Reasoning color: a heads-up signal, not a failure signal. Stays neutral
    /// at low shares, leans accent as it climbs past ~50% (meaningful slice of
    /// output is invisible thinking), amber past 80% (most of the cost isn't
    /// visible to the caller — worth questioning the routing choice).
    private func reasoningColor(_ share: Double) -> Color {
        if share >= 0.80 { return theme.statusWarning }
        if share >= 0.50 { return c.tertiary }
        return theme.backgroundMode.secondaryTextColor
    }

    /// Billing color: matches Apple's idiom on time-bounded resources (Screen
    /// Time, battery, Focus) — cool through ~75%, amber 75–90%, red ≥90%.
    /// At 90% you have ~30 min in the 5h block, which is roughly when "head
    /// up, plan your last thing" becomes "this is closing now".
    private func billingColor(_ elapsedPct: Double) -> Color {
        if elapsedPct >= 90 { return theme.statusDanger }
        if elapsedPct >= 75 { return theme.statusWarning }
        return c.secondary
    }

    /// "2h12m" / "47m" — short countdown for the chip face. Trims the hour
    /// segment when zero so we don't waste pixels on "0h47m".
    private func formatRemaining(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 { return "\(h)h\(m)m" }
        return "\(m)m"
    }

    /// "2 hours 12 minutes" — the tooltip-friendly long form. Used in help
    /// text where readability beats compactness.
    private func formatRemainingLong(_ seconds: Int) -> String {
        let h = seconds / 3600
        let m = (seconds % 3600) / 60
        if h > 0 && m > 0 { return "\(h)h \(m)m" }
        if h > 0 { return "\(h)h" }
        return "\(m)m"
    }
}

/// Each reading keeps its intrinsic width; additional signals start a new row.
private struct SignalFlowLayout: Layout {
    private func arrangement(width: CGFloat, subviews: Subviews) -> (CGSize, [CGPoint]) {
        var points: [CGPoint] = []
        var x: CGFloat = 0
        var y: CGFloat = 0
        var rowHeight: CGFloat = 0
        var usedWidth: CGFloat = 0
        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)
            if x > 0 && x + size.width > width {
                x = 0
                y += rowHeight + 8
                rowHeight = 0
            }
            points.append(CGPoint(x: x, y: y))
            usedWidth = max(usedWidth, x + size.width)
            x += size.width + 12
            rowHeight = max(rowHeight, size.height)
        }
        return (CGSize(width: usedWidth, height: y + rowHeight), points)
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let (size, _) = arrangement(width: proposal.width ?? .infinity, subviews: subviews)
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let (_, points) = arrangement(width: bounds.width, subviews: subviews)
        for (subview, point) in zip(subviews, points) {
            subview.place(at: CGPoint(x: bounds.minX + point.x, y: bounds.minY + point.y),
                          anchor: .topLeading, proposal: .unspecified)
        }
    }
}
