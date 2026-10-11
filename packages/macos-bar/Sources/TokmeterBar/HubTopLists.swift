// HubTopLists.swift — "Top projects" + "Top models" cards for the Hub.
//
// Both share the same row idiom (gradient bar + cost), differ in what they
// rank. Pure presentation — data shape is whatever the loader hands us.

import SwiftUI

struct HubTopProjectsList: View {
    let projects: [ProjectData]
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                if theme == .paper {
                    HubPaperTitle(text: "Top projects")
                    Spacer()
                    HubPaperLabel(text: "by cost")
                } else {
                Text("Top projects")
                    .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Spacer()
                Text("by cost")
                    .font(.system(size: 9, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                }
            }

            if projects.isEmpty {
                HubEmptyState(icon: "folder", message: "No project data yet", theme: theme)
            } else {
                VStack(spacing: theme == .paper ? 0 : 6) {
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
        if theme == .paper {
            paperBody
        } else {
            standardBody
        }
    }

    /// Paper: a numbered table line with dotted leaders to the figure.
    private var paperBody: some View {
        VStack(spacing: 0) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text("\(rank).")
                    .font(.system(size: 12, weight: .bold, design: .serif))
                    .monospacedDigit()
                    .foregroundColor(Broadsheet.muted)
                    .frame(width: 20, alignment: .leading)
                Text(project.project)
                    .font(.system(size: 13.5, weight: .semibold, design: .serif))
                    .foregroundColor(Broadsheet.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                LeaderDots()
                Kicker(text: "\(project.activeDays) day\(project.activeDays == 1 ? "" : "s")",
                       color: Broadsheet.muted)
                    .fixedSize()
                Text(Fmt.cost(project.totalCost))
                    .font(.system(size: 13.5, weight: .bold, design: .serif))
                    .monospacedDigit()
                    .foregroundColor(Broadsheet.ink)
                    .frame(minWidth: 56, alignment: .trailing)
            }
            .padding(.vertical, 7)
            .background(hovered ? Broadsheet.ink.opacity(0.05) : Color.clear)
            InkRule(weight: 0.5, color: Broadsheet.ink.opacity(0.35))
        }
        .onHover { hovered = $0 }
        .help(tooltip)
    }

    private var standardBody: some View {
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
        .help(tooltip)
    }

    /// Hover summary: total cost, active days, and average $/active-day.
    private var tooltip: String {
        let days = max(1, project.activeDays)
        let perDay = project.totalCost / Double(days)
        return String(
            format: "%@ — %@ across %d active day%@ (avg %@/day)",
            project.project, Fmt.cost(project.totalCost), project.activeDays,
            project.activeDays == 1 ? "" : "s", Fmt.cost(perDay)
        )
    }
}

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
                if theme == .paper {
                    HubPaperTitle(text: "Top models")
                    Spacer()
                    HubPaperLabel(text: "by cost share")
                } else {
                Text("Top models")
                    .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Spacer()
                Text("by cost share")
                    .font(.system(size: 9, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                }
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
        if theme == .paper {
            paperBody
        } else {
            standardBody
        }
    }

    /// Paper: name, leaders, figure; the share as a flat ink rule beneath.
    private var paperBody: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(shortModelName(model.model))
                    .font(.system(size: 12.5, weight: .semibold, design: .monospaced))
                    .foregroundColor(Broadsheet.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                LeaderDots()
                Text("\(Int((shareOfTotal * 100).rounded()))%")
                    .font(Broadsheet.kickerFont)
                    .foregroundColor(Broadsheet.muted)
                    .monospacedDigit()
                Text(Fmt.cost(model.cost))
                    .font(.system(size: 13, weight: .bold, design: .serif))
                    .monospacedDigit()
                    .foregroundColor(Broadsheet.ink)
            }
            HubPaperMeter(fraction: shareOfTotal)
                .help(compositionTooltip(
                    output: model.outputTokens,
                    cacheRead: model.cacheReadTokens,
                    cacheWrite: model.cacheWriteTokens,
                    input: model.inputTokens,
                    reasoning: model.reasoningTokens
                ))
        }
    }

    private var standardBody: some View {
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
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(Color.primary.opacity(bg.isLight ? 0.06 : 0.08))
                    Capsule()
                        .fill(compositionFill(
                            output: model.outputTokens,
                            cacheRead: model.cacheReadTokens,
                            cacheWrite: model.cacheWriteTokens,
                            input: model.inputTokens,
                            reasoning: model.reasoningTokens,
                            theme: theme,
                            fallback: LinearGradient(
                                colors: [c.primary, c.secondary, c.warm],
                                startPoint: .leading, endPoint: .trailing
                            )
                        ))
                        .frame(width: safeDim(geo.size.width * CGFloat(shareOfTotal), floor: 4))
                }
            }
            .frame(height: 5)
            .help(compositionTooltip(
                output: model.outputTokens,
                cacheRead: model.cacheReadTokens,
                cacheWrite: model.cacheWriteTokens,
                input: model.inputTokens,
                reasoning: model.reasoningTokens
            ))
        }
    }

    /// Drop the `anthropic/` or `openai/` prefix when present.
    private func shortModelName(_ full: String) -> String {
        if let slash = full.firstIndex(of: "/") {
            return String(full[full.index(after: slash)...])
        }
        return full
    }
}
