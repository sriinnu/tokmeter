// HubOverview.swift — The Hub's dashboard pane (orchestrator).
//
// Layout (top-to-bottom):
//   ┌ KPI tiles (4 across) ───────────────────────────────┐
//   │ Total cost · Total tokens · Today cost · Projects   │
//   ├ Today's pulse ─────────────────────────────────────┤
//   │ Burn / Cache / Compaction / Reasoning + billing     │
//   ├ Today's tools ─────────────────────────────────────┤
//   │ Animated cost-per-tool bars                         │
//   ├ 30-day activity chart ─────────────────────────────┤
//   │ Bars + 7-day moving avg                             │
//   ├ 365-day heatmap ───────────────────────────────────┤
//   │ GitHub-style year-at-a-glance                       │
//   └ Top projects ──── │ ──── Top models ─────────────────┘
//
// Each section is its own View struct in a sibling file (HubPulseCard,
// HubToolCallsCard, HubActivityChart, HubYearHeatmap, HubTopLists, HubCard,
// HubKpiTile). This file orchestrates the cascade and the conditional
// rendering, keeping the orchestrator under the per-file budget.

import SwiftUI

struct HubOverviewPanel: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private var last30: [DailyUsage] {
        Array(loader.allDaily.suffix(30))
    }

    private var topProjectsByCost: [ProjectData] {
        loader.sessions.sorted { $0.totalCost > $1.totalCost }.prefix(6).map { $0 }
    }

    var body: some View {
        ScrollView(.vertical) {
            VStack(alignment: .leading, spacing: 20) {
                header
                    .cascadeIn(delay: 0.06)
                kpiRow
                    .cascadeIn(delay: 0.12)
                if let signals = loader.statbarSignals,
                   HubPulseCard.hasContent(signals) {
                    HubPulseCard(signals: signals, theme: theme)
                        .cascadeIn(delay: 0.18)
                }
                if let signals = loader.statbarSignals,
                   !signals.toolCallsToday.byTool.isEmpty {
                    HubToolCallsCard(tools: signals.toolCallsToday, theme: theme)
                        .cascadeIn(delay: 0.22)
                }
                activityCard
                    .cascadeIn(delay: 0.26)
                heatmapCard
                    .cascadeIn(delay: 0.30)
                if let comp = loader.crossToolComparison,
                   !comp.projections.isEmpty {
                    HubCrossToolCard(comparison: comp, theme: theme)
                        .cascadeIn(delay: 0.34)
                }
                bottomRow
                    .cascadeIn(delay: 0.42)
            }
            .padding(28)
        }
        .scrollIndicators(.never)
    }

    // MARK: - Header

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Overview")
                    .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("Everything you've spent, everywhere — at a glance.")
                    .font(.system(size: 12, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            Spacer()
            // Tok waves hello from the header — the mascot echoed where there's
            // real room, not crammed into a data view.
            TokMascot(theme: theme, scale: 0.62)
        }
    }

    // MARK: - KPI row

    // A LazyVGrid with fixed flexible columns — NOT an HStack of
    // `.frame(maxWidth: .infinity)` cards. Four greedy equal-priority cards in an
    // HStack let the flex solver re-divide width on every render; when a tile's
    // numericText value changes on the 30s poll, its transient intrinsic width
    // perturbs the split and, at large width (lots of slack), the solver never
    // settles within AppKit's Update-Constraints pass budget → crash. A grid
    // resolves column widths deterministically (available/4), so a tile's content
    // can no longer feed back into the row's geometry.
    private var kpiRow: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible(), spacing: 12), count: 4),
            spacing: 12
        ) {
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

    // MARK: - 30-day activity

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

    // MARK: - 365-day heatmap

    private var heatmapCard: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("365-day activity")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    HeatmapLegend(theme: theme)
                }
                // Heatmap sizes its own height to whatever 7 rows need at the
                // width-derived cell size (it reports that up via a preference),
                // so it fills the width AND never overflows into the card below.
                YearHeatmap(daily: loader.allDaily, theme: theme)
            }
        }
    }

    // MARK: - Top projects + Top models

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
