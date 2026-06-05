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
