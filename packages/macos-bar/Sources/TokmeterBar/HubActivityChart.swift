// HubActivityChart.swift — 30-day combo chart + tooltip + legend for the Hub.
//
// Swift Charts BarMark + LineMark, hover-driven RuleMark guide, glass-material
// tooltip anchored top-right of the plot frame. No continuous animation —
// hover state is the only thing that moves once the chart paints.

import Charts
import SwiftUI

/// Themed Swift Charts combo chart: per-day cost bars overlaid with a 7-day
/// moving-average line. Bars use a vertical theme gradient; the trend line
/// uses the theme's accent so it reads distinctly on top.
struct HubActivityChart: View {
    let daily: [DailyUsage]
    let theme: AppTheme

    @State private var hoveredDate: String?

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// 7-day trailing average, clamped at the leading edge so the first few
    /// days reflect a smaller window rather than zero-padding skewing low.
    private var movingAvg: [TrendPoint] {
        guard !daily.isEmpty else { return [] }
        let window = 7
        return daily.enumerated().map { idx, d in
            let start = max(0, idx - window + 1)
            let slice = daily[start...idx]
            let avg = slice.reduce(0.0) { $0 + $1.cost } / Double(slice.count)
            return TrendPoint(date: d.date, value: avg)
        }
    }

    private var byDate: [String: (bar: Double, avg: Double)] {
        var map: [String: (bar: Double, avg: Double)] = [:]
        for d in daily { map[d.date, default: (0, 0)].bar = d.cost }
        for p in movingAvg { map[p.date, default: (0, 0)].avg = p.value }
        return map
    }

    var body: some View {
        Chart {
            ForEach(daily) { d in
                BarMark(
                    x: .value("Day", d.date),
                    y: .value("Cost", d.cost)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [c.primary.opacity(0.85), c.secondary.opacity(0.85), c.warm.opacity(0.85)],
                        startPoint: .bottom, endPoint: .top
                    )
                )
                .cornerRadius(3)
            }
            ForEach(movingAvg) { p in
                LineMark(
                    x: .value("Day", p.date),
                    y: .value("7-day avg", p.value)
                )
                .foregroundStyle(c.accent)
                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)
            }
            if let last = movingAvg.last {
                PointMark(
                    x: .value("Day", last.date),
                    y: .value("7-day avg", last.value)
                )
                .foregroundStyle(c.accent)
                .symbolSize(70)
            }
            if let hd = hoveredDate, let v = byDate[hd] {
                RuleMark(x: .value("Day", hd))
                    .foregroundStyle(c.accent.opacity(0.35))
                    .lineStyle(StrokeStyle(lineWidth: 1, dash: [3, 3]))
                PointMark(x: .value("Day", hd), y: .value("Cost", v.bar))
                    .foregroundStyle(c.warm)
                    .symbolSize(55)
                PointMark(x: .value("Day", hd), y: .value("7-day avg", v.avg))
                    .foregroundStyle(c.accent)
                    .symbolSize(60)
            }
        }
        .chartOverlay { proxy in
            GeometryReader { geo in
                Rectangle().fill(.clear).contentShape(Rectangle())
                    .onContinuousHover { phase in
                        switch phase {
                        case .active(let pt):
                            guard let plotFrame = proxy.plotFrame else { return }
                            let plotX = pt.x - geo[plotFrame].origin.x
                            if let date: String = proxy.value(atX: plotX) {
                                hoveredDate = date
                            } else {
                                hoveredDate = nil
                            }
                        case .ended:
                            hoveredDate = nil
                        }
                    }
            }
        }
        .overlay(alignment: .topTrailing) {
            if let hd = hoveredDate, let v = byDate[hd] {
                HubChartTooltip(date: hd, daily: v.bar, avg: v.avg, theme: theme)
                    .padding(8)
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
        }
        .animation(.spring(response: 0.28, dampingFraction: 0.72), value: hoveredDate)
        .chartXAxis {
            AxisMarks(values: labelDays) { value in
                AxisValueLabel {
                    if let s = value.as(String.self) {
                        Text(shortDate(s))
                            .font(.system(size: 9, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.secondaryTextColor)
                    }
                }
                AxisTick().foregroundStyle(bg.secondaryTextColor.opacity(0.35))
            }
        }
        .chartYAxis {
            AxisMarks { value in
                AxisGridLine().foregroundStyle(bg.secondaryTextColor.opacity(0.12))
                AxisValueLabel {
                    if let d = value.as(Double.self) {
                        Text(Fmt.cost(d))
                            .font(.system(size: 9, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.secondaryTextColor)
                    }
                }
            }
        }
    }

    private var labelDays: [String] {
        guard !daily.isEmpty else { return [] }
        let step = max(1, daily.count / 6)
        var out: [String] = []
        for (idx, d) in daily.enumerated() {
            if idx % step == 0 || idx == daily.count - 1 {
                out.append(d.date)
            }
        }
        return out
    }

    private func shortDate(_ iso: String) -> String {
        guard iso.count >= 10 else { return iso }
        let month = Int(iso.dropFirst(5).prefix(2)) ?? 0
        let day = String(iso.dropFirst(8).prefix(2))
        let monthName = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(monthName[safe: month] ?? "") \(day)".trimmingCharacters(in: .whitespaces)
    }
}

private extension Array {
    subscript(safe idx: Int) -> Element? { indices.contains(idx) ? self[idx] : nil }
}

/// Single smoothed-trend sample. Separate identity from DailyUsage so both
/// series can iterate in the same Chart without id collisions.
private struct TrendPoint: Identifiable {
    let date: String
    let value: Double
    var id: String { "avg-\(date)" }
}

/// Floating details card shown when the user hovers the activity chart.
/// Reports raw daily cost + 7-day rolling average at the hovered date.
struct HubChartTooltip: View {
    let date: String
    let daily: Double
    let avg: Double
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(prettyDate)
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                .tracking(0.5)
                .foregroundColor(bg.secondaryTextColor)
            tooltipRow(
                label: "Daily",
                value: Fmt.cost(daily),
                swatch: LinearGradient(
                    colors: [c.primary, c.secondary, c.warm],
                    startPoint: .bottom, endPoint: .top
                )
            )
            tooltipRow(
                label: "7-day avg",
                value: Fmt.cost(avg),
                swatch: LinearGradient(
                    colors: [c.accent, c.accent],
                    startPoint: .top, endPoint: .bottom
                )
            )
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(.ultraThinMaterial)
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .stroke(c.accent.opacity(0.35), lineWidth: 1)
                )
                .shadow(color: Color.black.opacity(bg.isLight ? 0.12 : 0.35), radius: 6, y: 2)
        )
        .fixedSize(horizontal: true, vertical: true)
    }

    private var prettyDate: String {
        guard date.count >= 10 else { return date }
        let year = String(date.prefix(4))
        let month = Int(date.dropFirst(5).prefix(2)) ?? 0
        let day = String(date.dropFirst(8).prefix(2))
        let monthName = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                         "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        return "\(monthName[safe: month] ?? "") \(day), \(year)"
    }

    @ViewBuilder
    private func tooltipRow(label: String, value: String, swatch: LinearGradient) -> some View {
        HStack(spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(swatch)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
        }
    }
}

/// Two-chip legend: gradient square for bars, accent line for the 7-day avg.
struct HubChartLegend: View {
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(spacing: 10) {
            HStack(spacing: 5) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(
                        LinearGradient(
                            colors: [c.primary, c.secondary, c.warm],
                            startPoint: .bottom, endPoint: .top
                        )
                    )
                    .frame(width: 9, height: 9)
                Text("Daily")
                    .font(.system(size: 9, weight: .medium, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            HStack(spacing: 5) {
                Capsule()
                    .fill(c.accent)
                    .frame(width: 12, height: 2)
                Text("7-day avg")
                    .font(.system(size: 9, weight: .medium, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
        }
    }
}
