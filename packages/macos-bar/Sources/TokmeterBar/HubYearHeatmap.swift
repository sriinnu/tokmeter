// HubYearHeatmap.swift — GitHub-style 365-day activity grid for the Hub.
//
// Columns = weeks, rows = days-of-week (Mon..Sun). Color intensity maps to
// daily cost on a log scale so a single big day doesn't wash the rest of
// the year into the lowest bucket. Only the hovered cell animates after
// initial render — 365 cells animating in unison would be GPU-loud.

import SwiftUI

/// 52- or 53-week grid: columns = weeks, rows = days-of-week (Mon..Sun).
/// One row of month-letter labels above the grid for orientation. The grid
/// stops at "today" so future cells aren't drawn empty.
///
/// Color encoding: log10(cost + 1) normalized against the 95th percentile,
/// so a single outlier day doesn't crush the rest of the year into the
/// lowest bucket. Empty days (no records) render as a muted background tint
/// instead of pure black — keeps the grid visually continuous even on weeks
/// off.
struct YearHeatmap: View {
    let daily: [DailyUsage]
    let theme: AppTheme

    @State private var hovered: String?
    /// Cached grid + month-label keyed by `gridDateKey` (today's start-of-day
    /// string). 365 × 2 `Calendar.date(byAdding:)` calls used to fire every
    /// time the parent's 30s data poll re-rendered. Now: built once on
    /// appear, rebuilt only when the date rolls over.
    @State private var gridCache: [[Date?]] = []
    @State private var gridDateKey: String = ""

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// Build a date→cost lookup once per render so cell rendering stays O(1).
    private var costByDate: [String: Double] {
        Dictionary(uniqueKeysWithValues: daily.map { ($0.date, $0.cost) })
    }

    /// Full per-day lookup for the hover tooltip (cost + tokens).
    private var dailyByDate: [String: DailyUsage] {
        Dictionary(daily.map { ($0.date, $0) }, uniquingKeysWith: { _, b in b })
    }

    /// 95th-percentile clip on the log scale. Picks the visual ceiling so
    /// most cells land in the readable middle of the gradient instead of
    /// the lowest bucket. Falls back to 1.0 when the data is empty.
    private var logCeiling: Double {
        let positives = daily.map { log10(max(0, $0.cost) + 1) }.filter { $0 > 0 }
        guard !positives.isEmpty else { return 1.0 }
        let sorted = positives.sorted()
        let idx = min(sorted.count - 1, Int(Double(sorted.count) * 0.95))
        return max(0.01, sorted[idx])
    }

    /// 365 days back from today, Monday-aligned so column boundaries land on
    /// week starts. Pure function — derived from `today` only.
    private static func buildGrid(today: Date) -> [[Date?]] {
        let calendar = Calendar(identifier: .gregorian)
        let weeksBack = 52
        let dayBack = calendar.date(byAdding: .day, value: -weeksBack * 7, to: today) ?? today
        let weekdayBack = calendar.component(.weekday, from: dayBack) // Sun=1..Sat=7
        let mondayOffset = ((weekdayBack + 5) % 7) // Mon=0
        let start = calendar.date(byAdding: .day, value: -mondayOffset, to: dayBack) ?? dayBack
        var columns: [[Date?]] = []
        var cursor = start
        while cursor <= today {
            var col: [Date?] = []
            for _ in 0..<7 {
                col.append(cursor > today ? nil : cursor)
                cursor = calendar.date(byAdding: .day, value: 1, to: cursor) ?? cursor
            }
            columns.append(col)
        }
        return columns
    }

    private var grid: [[Date?]] { gridCache }

    private static let cellGap: CGFloat = 2
    private static let labelRow: CGFloat = 12
    private static let vspacing: CGFloat = 4
    /// Ceiling on cell size so an ultra-wide/fullscreen window doesn't blow the
    /// squares up huge (and make the whole grid absurdly tall). Above this the
    /// grid stops growing and centers, keeping it tidy.
    private static let maxCell: CGFloat = 22

    var body: some View {
        // SELF-SIZING grid: each of the 7-tall columns is an equal-width slot
        // (maxWidth: .infinity) and each cell is square via aspectRatio, so the
        // grid reports its true height to the parent with NO GeometryReader and
        // NO height feedback loop — it can never overflow into the card below
        // (the bug the fixed-height and preference approaches both hit). The
        // grid fills the width up to maxCell, then centers.
        VStack(alignment: .center, spacing: Self.vspacing) {
            monthLabels(gap: Self.cellGap)
            HStack(spacing: Self.cellGap) {
                ForEach(Array(grid.enumerated()), id: \.offset) { _, column in
                    VStack(spacing: Self.cellGap) {
                        ForEach(Array(column.enumerated()), id: \.offset) { _, date in
                            cell(for: date)
                        }
                    }
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .frame(maxWidth: Self.maxCell * 53 + Self.cellGap * 52)  // cap + center on ultra-wide
        .frame(maxWidth: .infinity, alignment: .center)
        // Instant floating tooltip for the hovered day — snappier than the
        // native .help() (kept for accessibility). Anchored top-right.
        .overlay(alignment: .topTrailing) {
            if let key = hovered, let d = dailyByDate[key] {
                HeatmapCellTooltip(day: d, theme: theme)
                    .padding(.top, 2)
                    .transition(.opacity.combined(with: .scale(scale: 0.92, anchor: .topTrailing)))
                    .allowsHitTesting(false)
            }
        }
        .animation(.spring(response: 0.25, dampingFraction: 0.75), value: hovered)
        .onAppear(perform: rebuildGridIfStale)
        // Cheap guard against day rollover while popover is open: check on
        // every redraw whether today changed, only rebuild if so.
        .onChange(of: daily) { _, _ in rebuildGridIfStale() }
    }

    private func rebuildGridIfStale() {
        let today = Calendar(identifier: .gregorian).startOfDay(for: Date())
        let key = dateKey(today)
        if key != gridDateKey {
            gridCache = Self.buildGrid(today: today)
            gridDateKey = key
        }
    }

    @ViewBuilder
    private func cell(for date: Date?) -> some View {
        if let date = date {
            let key = dateKey(date)
            let cost = costByDate[key] ?? 0
            let intensity = colorIntensity(cost)
            let isHovered = hovered == key
            // aspectRatio(1) makes the cell square at whatever width the equal
            // column slot gives it — so the grid self-sizes its height. A fixed
            // corner radius reads fine across the cell-size range.
            RoundedRectangle(cornerRadius: 3)
                .fill(intensity > 0 ? c.accent.opacity(intensity) : bg.secondaryTextColor.opacity(0.08))
                .aspectRatio(1, contentMode: .fit)
                .scaleEffect(isHovered ? 1.15 : 1.0)
                .animation(.spring(response: 0.28, dampingFraction: 0.65), value: isHovered)
                .onHover { entered in
                    hovered = entered ? key : (hovered == key ? nil : hovered)
                }
                .help(tooltipText(date: date, cost: cost))
        } else {
            Color.clear.aspectRatio(1, contentMode: .fit)
        }
    }

    private func monthLabels(gap: CGFloat) -> some View {
        let calendar = Calendar(identifier: .gregorian)
        let formatter: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "MMM"
            return f
        }()
        var lastMonth = -1
        var labels: [(col: Int, text: String)] = []
        for (i, column) in grid.enumerated() {
            guard let first = column.first(where: { $0 != nil }) ?? nil else { continue }
            let m = calendar.component(.month, from: first)
            if m != lastMonth {
                labels.append((col: i, text: formatter.string(from: first)))
                lastMonth = m
            }
        }
        return HStack(spacing: gap) {
            ForEach(0..<grid.count, id: \.self) { i in
                Text(labels.first(where: { $0.col == i })?.text ?? "")
                    .font(.system(size: 8, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(height: Self.labelRow)
    }

    private func dateKey(_ d: Date) -> String {
        let calendar = Calendar(identifier: .gregorian)
        let y = calendar.component(.year, from: d)
        let m = calendar.component(.month, from: d)
        let day = calendar.component(.day, from: d)
        return String(format: "%04d-%02d-%02d", y, m, day)
    }

    private func colorIntensity(_ cost: Double) -> Double {
        guard cost > 0 else { return 0 }
        let logCost = log10(cost + 1)
        let normalized = min(1.0, logCost / logCeiling)
        return 0.15 + normalized * 0.85
    }

    private func tooltipText(date: Date, cost: Double) -> String {
        let formatter: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "EEE, MMM d, yyyy"
            return f
        }()
        let dateStr = formatter.string(from: date)
        if cost <= 0 { return "\(dateStr) — no activity" }
        return String(format: "%@ — $%.2f", dateStr, cost)
    }
}

/// Floating details card for the hovered heatmap day — date, cost, tokens.
/// Matches HubChartTooltip's glass style so the Hub reads as one system.
private struct HeatmapCellTooltip: View {
    let day: DailyUsage
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(prettyDate)
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                .tracking(0.5)
                .foregroundColor(bg.secondaryTextColor)
            if day.cost <= 0 && day.tokens <= 0 {
                Text("no activity")
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            } else {
                row(label: "Cost", value: Fmt.cost(day.cost))
                row(label: "Tokens", value: Fmt.number(day.tokens))
            }
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
        .fixedSize()
    }

    @ViewBuilder
    private func row(label: String, value: String) -> some View {
        HStack(spacing: 10) {
            Text(label)
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
            Spacer(minLength: 8)
            Text(value)
                .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
        }
    }

    private var prettyDate: String {
        let s = day.date
        guard s.count >= 10 else { return s }
        let year = String(s.prefix(4))
        let month = Int(s.dropFirst(5).prefix(2)) ?? 0
        let dd = String(s.dropFirst(8).prefix(2))
        let names = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
                     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
        let mn = (month >= 1 && month <= 12) ? names[month] : ""
        return "\(mn) \(dd), \(year)"
    }
}

/// Legend strip showing the color gradient from "no spend" → "peak day".
struct HeatmapLegend: View {
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(spacing: 4) {
            Text("less")
                .font(.system(size: 9, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
            ForEach([0.0, 0.25, 0.5, 0.75, 1.0], id: \.self) { intensity in
                RoundedRectangle(cornerRadius: 2)
                    .fill(intensity > 0 ? c.accent.opacity(0.15 + intensity * 0.85) : bg.secondaryTextColor.opacity(0.08))
                    .frame(width: 10, height: 10)
            }
            Text("more")
                .font(.system(size: 9, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }
}
