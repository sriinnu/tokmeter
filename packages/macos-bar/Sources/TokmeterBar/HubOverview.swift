// HubOverview.swift — the Hub's dashboard pane.
//
// Layout (top-to-bottom):
//   ┌ KPI tiles (4 across) ───────────────────────────────┐
//   │ Total cost · Total tokens · Today cost · Projects   │
//   ├─ 30-day activity chart ────────────────────────────┤
//   │ Swift Charts BarMark, theme-colored                 │
//   ├ Top projects (by cost) ─ │ ─ Top models (by cost %) │
//   └──────────────────────────┴──────────────────────────┘
//
// All data comes from the shared TokmeterLoader — the same timer that drives
// the bar also feeds this view; no duplicate polling. Every surface element
// springs in with a staggered cascade so the dashboard "assembles" itself
// rather than popping fully-formed.

import Charts
import SwiftUI

struct HubOverviewPanel: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// 30-day slice — more than 30 points is overkill on a bar chart at this
    /// width; fewer loses the shape of weekly cadence.
    private var last30: [DailyUsage] {
        Array(loader.allDaily.suffix(30))
    }

    /// Top 6 projects by cost. `sessions` is already sorted by recency in
    /// the loader; re-sort here so the Overview reflects spend, not activity.
    private var topProjectsByCost: [ProjectData] {
        loader.sessions.sorted { $0.totalCost > $1.totalCost }.prefix(6).map { $0 }
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 20) {
                header
                    .cascadeIn(delay: 0.06)
                kpiRow
                    .cascadeIn(delay: 0.12)
                activityCard
                    .cascadeIn(delay: 0.22)
                bottomRow
                    .cascadeIn(delay: 0.32)
            }
            .padding(28)
        }
    }

    // MARK: - Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Overview")
                .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("Everything you've spent, everywhere — at a glance.")
                .font(.system(size: 12, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }

    // MARK: - KPI row

    private var kpiRow: some View {
        HStack(spacing: 12) {
            HubKpiTile(
                label: "Total cost",
                value: Fmt.cost(loader.totalCost),
                icon: "dollarsign.circle.fill",
                accent: c.highlight,
                theme: theme
            )
            HubKpiTile(
                label: "Total tokens",
                value: Fmt.number(loader.totalTokens),
                icon: "cube.fill",
                accent: c.secondary,
                theme: theme
            )
            HubKpiTile(
                label: "Today",
                value: Fmt.cost(loader.todayCost),
                icon: "sun.max.fill",
                accent: c.accent,
                theme: theme
            )
            HubKpiTile(
                label: "Projects",
                value: "\(loader.stats?.projects ?? 0)",
                icon: "folder.fill",
                accent: c.warm,
                theme: theme
            )
        }
    }

    // MARK: - Activity card

    private var activityCard: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("30-day activity")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    HubChartLegend(theme: theme)
                    if let first = last30.first, let last = last30.last {
                        Text("\(first.date) — \(last.date)")
                            .font(.system(size: 10, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.secondaryTextColor)
                            .padding(.leading, 10)
                    }
                }
                HubActivityChart(daily: last30, theme: theme)
                    .frame(height: 180)
            }
        }
    }

    // MARK: - Bottom split

    private var bottomRow: some View {
        HStack(alignment: .top, spacing: 12) {
            HubCard(theme: theme) {
                HubTopProjectsList(projects: topProjectsByCost, theme: theme)
            }
            HubCard(theme: theme) {
                HubTopModelsList(models: Array(loader.topModels.prefix(6)), theme: theme)
            }
        }
    }
}

// ─── KPI tile ─────────────────────────────────────────────────────────────

/// Themed KPI card: accent-colored icon pip, big value, small label. Hovers
/// lift slightly — the same idiom as the bar's popover rows.
struct HubKpiTile: View {
    let label: String
    let value: String
    let icon: String
    let accent: Color
    let theme: AppTheme

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HubCard(theme: theme) {
            HStack(alignment: .center, spacing: 12) {
                ZStack {
                    RoundedRectangle(cornerRadius: 9)
                        .fill(accent.opacity(0.18))
                        .frame(width: 36, height: 36)
                    Image(systemName: icon)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(accent)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(label.uppercased())
                        .font(.system(size: 9, weight: .semibold, design: theme.fonts.labelDesign))
                        .tracking(1.3)
                        .foregroundColor(bg.secondaryTextColor)
                    Text(value)
                        .font(.system(size: 20, weight: .bold, design: theme.fonts.valueDesign))
                        .foregroundColor(bg.primaryTextColor)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Spacer(minLength: 0)
            }
        }
        .scaleEffect(hovered ? 1.015 : 1.0)
        .offset(y: hovered ? -1 : 0)
        .animation(.spring(response: 0.32, dampingFraction: 0.70), value: hovered)
        .onHover { hovered = $0 }
    }
}

// ─── Activity chart ───────────────────────────────────────────────────────

/// Themed Swift Charts combo chart: per-day cost bars overlaid with a 7-day
/// moving-average line. The bars show raw daily spend; the line smooths out
/// noise and surfaces the actual trend. Bars use a vertical theme gradient;
/// the trend line uses the theme's accent so it reads distinctly on top.
struct HubActivityChart: View {
    let daily: [DailyUsage]
    let theme: AppTheme

    /// Which x-axis date the pointer is currently hovering over, if any.
    /// Drives the vertical guide line + the floating tooltip.
    @State private var hoveredDate: String?

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// 7-day trailing average. Each point averages the current day plus the
    /// previous 6 (clamped at the leading edge, so the first few days reflect
    /// a smaller window rather than zero-padding skewing the line low).
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

    /// Quick lookup so the tooltip can cheaply find the bar + avg values for
    /// whichever date the cursor is over.
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

            // Smoothed trailing average. Catmull-Rom gives the "breathing"
            // curve rather than angular zig-zags. Sits above the bars with
            // a soft shadow so it reads as its own layer, not chart chrome.
            ForEach(movingAvg) { p in
                LineMark(
                    x: .value("Day", p.date),
                    y: .value("7-day avg", p.value)
                )
                .foregroundStyle(c.accent)
                .lineStyle(StrokeStyle(lineWidth: 2.2, lineCap: .round, lineJoin: .round))
                .interpolationMethod(.catmullRom)
            }
            // Terminal dot on the latest point — pixar nudge so the eye
            // lands on "most recent" without reading labels.
            if let last = movingAvg.last {
                PointMark(
                    x: .value("Day", last.date),
                    y: .value("7-day avg", last.value)
                )
                .foregroundStyle(c.accent)
                .symbolSize(70)
            }

            // Hover chrome — a vertical guide and two highlighted points that
            // match the user's current x position. Swift Charts paints them
            // inside the plot frame automatically, so they clip cleanly to
            // the axes.
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
                            // Convert window coord → plot-local x, then ask
                            // the proxy which date that x belongs to.
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
            // Anchored top-right so the tooltip never shifts a bar column or
            // runs past the chart edge. RuleMark inside the Chart provides
            // the spatial anchor — the tooltip just reports the values.
            if let hd = hoveredDate, let v = byDate[hd] {
                HubChartTooltip(date: hd, daily: v.bar, avg: v.avg, theme: theme)
                    .padding(8)
                    .transition(.opacity.combined(with: .scale(scale: 0.92)))
            }
        }
        .animation(.spring(response: 0.28, dampingFraction: 0.72), value: hoveredDate)
        .chartXAxis {
            // Sparse label strategy: every ~5th day + the last one. Keeps the
            // axis readable at 30 bars wide without squinting.
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

    /// Sparse label values: first, every ~5th, last.
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

    /// Show "Apr 14" instead of "2026-04-14" on axis — less crowded.
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

// ─── Chart tooltip ────────────────────────────────────────────────────────

/// Floating details card shown when the user hovers the activity chart.
/// Reports the raw daily cost and the 7-day rolling average at the hovered
/// date. Styled against the theme so it sits on any backdrop without extra
/// contrast work.
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
        // Lock to content width — without this the inner HStack Spacer
        // makes the whole card greedy and it takes the overlay's full width.
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

// ─── Legend ───────────────────────────────────────────────────────────────

/// Two-chip legend above the activity chart: a gradient square for the bars,
/// a short accent line for the 7-day average. Small, themed, non-intrusive.
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

// ─── Top projects ─────────────────────────────────────────────────────────

struct HubTopProjectsList: View {
    let projects: [ProjectData]
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Top projects")
                    .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Spacer()
                Text("by cost")
                    .font(.system(size: 9, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }

            if projects.isEmpty {
                HubEmptyState(icon: "folder", message: "No project data yet", theme: theme)
            } else {
                VStack(spacing: 6) {
                    ForEach(Array(projects.enumerated()), id: \.element.id) { idx, p in
                        HubTopProjectRow(rank: idx + 1, project: p, theme: theme)
                    }
                }
            }
        }
    }
}

struct HubTopProjectRow: View {
    let rank: Int
    let project: ProjectData
    let theme: AppTheme

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(spacing: 10) {
            Text("\(rank)")
                .font(.system(size: 10, weight: .bold, design: theme.fonts.labelDesign))
                .foregroundColor(c.accent)
                .frame(width: 16, alignment: .leading)
            Text(project.project)
                .font(.system(size: 12, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.primaryTextColor)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text("\(project.activeDays) day\(project.activeDays == 1 ? "" : "s")")
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
            Text(Fmt.cost(project.totalCost))
                .font(.system(size: 12, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
                .frame(minWidth: 60, alignment: .trailing)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(hovered ? Color.primary.opacity(bg.isLight ? 0.04 : 0.06) : Color.clear)
        )
        .scaleEffect(hovered ? 1.005 : 1.0)
        .animation(.spring(response: 0.30, dampingFraction: 0.72), value: hovered)
        .onHover { hovered = $0 }
    }
}

// ─── Top models ───────────────────────────────────────────────────────────

struct HubTopModelsList: View {
    let models: [ModelUsage]
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private var totalCost: Double {
        models.reduce(0) { $0 + $1.cost }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Top models")
                    .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Spacer()
                Text("by cost share")
                    .font(.system(size: 9, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }

            if models.isEmpty {
                HubEmptyState(icon: "cube", message: "No model data yet", theme: theme)
            } else {
                VStack(spacing: 8) {
                    ForEach(models) { m in
                        HubTopModelRow(
                            model: m,
                            shareOfTotal: totalCost > 0 ? m.cost / totalCost : 0,
                            theme: theme
                        )
                    }
                }
            }
        }
    }
}

struct HubTopModelRow: View {
    let model: ModelUsage
    let shareOfTotal: Double
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(shortModelName(model.model))
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text(Fmt.cost(model.cost))
                    .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
            }
            // Gradient progress bar — share of the top-models total cost.
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.primary.opacity(bg.isLight ? 0.06 : 0.08))
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [c.primary, c.secondary, c.warm],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                        .frame(width: max(4, geo.size.width * CGFloat(shareOfTotal)))
                }
            }
            .frame(height: 5)
        }
    }

    /// Drop the `anthropic/` or `openai/` prefix when present — those come
    /// from registry identifiers and just eat horizontal room in the pill.
    private func shortModelName(_ full: String) -> String {
        if let slash = full.firstIndex(of: "/") {
            return String(full[full.index(after: slash)...])
        }
        return full
    }
}

// ─── Shared card + empty state ────────────────────────────────────────────

/// Themed card wrapper — used by every surface in the Hub so spacing, fill,
/// border, and hover behavior are consistent.
struct HubCard<Content: View>: View {
    let theme: AppTheme
    let content: () -> Content

    init(theme: AppTheme, @ViewBuilder content: @escaping () -> Content) {
        self.theme = theme
        self.content = content
    }

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        content()
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(Color.primary.opacity(bg.isLight ? 0.03 : 0.05))
                    .overlay(
                        RoundedRectangle(cornerRadius: 14)
                            .stroke(c.accent.opacity(0.12), lineWidth: 1)
                    )
            )
    }
}

struct HubEmptyState: View {
    let icon: String
    let message: String
    let theme: AppTheme

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: icon)
                .font(.system(size: 24, weight: .light))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            Text(message)
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 30)
    }
}
