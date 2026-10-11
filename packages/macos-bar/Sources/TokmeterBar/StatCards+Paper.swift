// StatCards+Paper.swift — Paper's ledger: the three KPI cards set as a
// market-data table (name, trend line, figure, day change) instead of boxes.

import SwiftUI

extension StatsGrid {
    /// The ledger as data, for skins: tokens and cost all time, then pace
    /// (or the longest streak before there's a pace baseline).
    var ledgerRows: [LedgerRowData] {
        var rows = [
            LedgerRowData(
                id: "tokens", name: "Tokens", note: "all time",
                value: Fmt.number(loader.totalTokens),
                trend: recordedDayTrend(metric: .tokens) { Double($0.tokens) },
                spark: settledDaily.map { Double($0.tokens) }, sparkDays: settledDaily,
                isWarming: loader.isWarming),
            LedgerRowData(
                id: "cost", name: "Cost", note: "all time",
                value: Fmt.cost(loader.totalCost),
                trend: recordedDayTrend(metric: .cost) { $0.cost },
                spark: settledDaily.map { $0.cost }, sparkDays: settledDaily,
                isWarming: loader.isWarming),
        ]
        if let signals = loader.statbarSignals,
           let multiple = signals.pace.multiple,
           signals.pace.daysOfHistory >= 2 {
            rows.append(LedgerRowData(
                id: "pace", name: "Pace", note: "today vs usual",
                value: Fmt.paceMultiple(multiple),
                alert: multiple >= 1.25 ? theme.statusWarning : nil,
                trend: nil,
                spark: loader.recentDaily.map { $0.cost }, sparkDays: loader.recentDaily,
                isWarming: false))
        } else if let s = loader.stats {
            rows.append(LedgerRowData(
                id: "streak", name: "Streak", note: "longest",
                value: "\(s.longestStreak)d",
                trend: nil, spark: [], sparkDays: [], isWarming: false))
        }
        return rows
    }

    var paperLedger: some View {
        VStack(spacing: 0) {
            InkRule(weight: 2)
            HStack(spacing: 8) {
                Kicker(text: "The ledger", inverted: true)
                Spacer(minLength: 0)
                Kicker(text: "Trend", color: Broadsheet.muted)
                    .frame(width: 92, alignment: .center)
                Kicker(text: "Chg", color: Broadsheet.muted)
                    .frame(width: 50, alignment: .trailing)
            }
            .padding(.top, 6)
            .padding(.bottom, 4)
            InkRule(weight: 0.5)
            PaperLedgerRow(
                name: "Tokens", note: "all time",
                value: Fmt.number(loader.totalTokens),
                trend: recordedDayTrend(metric: .tokens) { Double($0.tokens) },
                spark: settledDaily.map { Double($0.tokens) }, sparkDays: settledDaily,
                isWarming: loader.isWarming, theme: theme
            )
            InkRule(weight: 0.5, color: Broadsheet.ink.opacity(0.3))
            PaperLedgerRow(
                name: "Cost", note: "all time",
                value: Fmt.cost(loader.totalCost),
                trend: recordedDayTrend(metric: .cost) { $0.cost },
                spark: settledDaily.map { $0.cost }, sparkDays: settledDaily,
                isWarming: loader.isWarming, theme: theme
            )
            if let signals = loader.statbarSignals,
               let multiple = signals.pace.multiple,
               signals.pace.daysOfHistory >= 2 {
                InkRule(weight: 0.5, color: Broadsheet.ink.opacity(0.3))
                PaperLedgerRow(
                    name: "Pace", note: "today vs usual",
                    value: Fmt.paceMultiple(multiple),
                    valueInk: multiple >= 1.25 ? theme.statusWarning : Broadsheet.ink,
                    trend: nil,
                    spark: loader.recentDaily.map { $0.cost }, sparkDays: loader.recentDaily,
                    isWarming: false, theme: theme
                )
            } else if let s = loader.stats {
                InkRule(weight: 0.5, color: Broadsheet.ink.opacity(0.3))
                PaperLedgerRow(
                    name: "Streak", note: "longest",
                    value: "\(s.longestStreak)d",
                    trend: nil, spark: [], sparkDays: [],
                    isWarming: false, theme: theme
                )
            }
            InkRule(weight: 1)
        }
    }
}

private struct PaperLedgerRow: View {
    let name: String
    let note: String
    let value: String
    /// Ink unless the reading needs attention (a hot pace).
    var valueInk: Color = Broadsheet.ink
    let trend: RecordedDayTrend?
    let spark: [Double]
    let sparkDays: [DailyUsage]
    let isWarming: Bool
    let theme: AppTheme

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                Text(name)
                    .font(Broadsheet.display(14, weight: .bold))
                    .foregroundColor(Broadsheet.ink)
                Text(note)
                    .font(.system(size: 10, design: .serif).italic())
                    .foregroundColor(Broadsheet.muted)
                    .lineLimit(1)
            }
            .layoutPriority(1)
            Spacer(minLength: 4)
            if isWarming {
                ShimmerBar(width: 52, height: 14, breathToggle: true)
            } else {
                Text(value)
                    .font(Broadsheet.display(17, weight: .heavy).monospacedDigit())
                    .foregroundColor(valueInk)
                    .lineLimit(1)
                    .contentTransition(.numericText())
                    .animation(.spring(response: 0.55, dampingFraction: 0.70), value: value)
            }
            InlineSparkline(values: spark, color: Broadsheet.ink, progress: 1, flat: true)
                .frame(width: 92, height: 14)
                .modifier(SparklineUsageHover(days: sparkDays, theme: theme))
                .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
            change
                .frame(width: 50, alignment: .trailing)
        }
        .padding(.vertical, 7)
    }

    @ViewBuilder
    private var change: some View {
        if let trend, !isWarming {
            let up = trend.percent >= 0
            Text("\(up ? "▲" : "▼") \(String(format: "%.1f", abs(trend.percent)))%")
                .font(.system(size: 10, weight: .semibold, design: .serif).monospacedDigit())
                .foregroundColor(trend.metric == .cost && up ? theme.statusWarning : Broadsheet.ink2)
                .lineLimit(1)
                .help(trend.description)
                .accessibilityLabel(trend.description)
        } else {
            Text("—")
                .font(.system(size: 10, design: .serif))
                .foregroundColor(Broadsheet.muted)
                .accessibilityHidden(true)
        }
    }
}
