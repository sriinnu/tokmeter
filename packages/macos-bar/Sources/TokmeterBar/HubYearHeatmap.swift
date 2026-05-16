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

    var body: some View {
        // Geometry-driven cell size so the grid always fits the Hub's
        // available width regardless of window size or sidebar state.
        // 52 columns × (12+2)pt = 728 used to overflow the ~676pt usable
        // hub width — last 3-4 weeks clipped. Now: cell = (width - gaps) / 52.
        GeometryReader { geo in
            let cellGap: CGFloat = 2
            let columns = max(1, grid.count)
            let cellSize = max(6, (geo.size.width - cellGap * CGFloat(columns - 1)) / CGFloat(columns))
            VStack(alignment: .leading, spacing: 4) {
                monthLabels(cellSize: cellSize, gap: cellGap)
                HStack(spacing: cellGap) {
                    ForEach(Array(grid.enumerated()), id: \.offset) { _, column in
                        VStack(spacing: cellGap) {
                            ForEach(Array(column.enumerated()), id: \.offset) { _, date in
                                cell(for: date, size: cellSize)
                            }
                        }
                    }
                }
            }
        }
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
    private func cell(for date: Date?, size: CGFloat) -> some View {
        if let date = date {
            let key = dateKey(date)
            let cost = costByDate[key] ?? 0
            let intensity = colorIntensity(cost)
            let isHovered = hovered == key
            // Hover scale dropped 1.25 → 1.15 — at 12pt cells the bigger
            // scale shoves neighbors visually since the 2pt gap is only 13%
            // of cell width. 1.15 reads as a clear lift without disturbing.
            RoundedRectangle(cornerRadius: size * 0.2)
                .fill(intensity > 0 ? c.accent.opacity(intensity) : bg.secondaryTextColor.opacity(0.08))
                .frame(width: size, height: size)
                .scaleEffect(isHovered ? 1.15 : 1.0)
                .animation(.spring(response: 0.28, dampingFraction: 0.65), value: isHovered)
                .onHover { entered in
                    hovered = entered ? key : (hovered == key ? nil : hovered)
                }
                .help(tooltipText(date: date, cost: cost))
        } else {
            Color.clear.frame(width: size, height: size)
        }
    }

    private func monthLabels(cellSize: CGFloat, gap: CGFloat) -> some View {
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
                    .frame(width: cellSize, alignment: .leading)
            }
        }
        .frame(height: 10)
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
