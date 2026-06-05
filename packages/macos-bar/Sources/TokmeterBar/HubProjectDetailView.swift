// HubProjectDetailView.swift — Detail screen for one project. Sits above
// HubProjectModelsList, HubProjectProvidersList, and HubProjectCliActions
// (their own files) — this view orchestrates them around the daily chart
// and KPI tiles.

import SwiftUI

struct HubProjectDetailView: View {
    let project: ProjectData
    let theme: AppTheme
    let onBack: () -> Void

    @State private var detail: ProjectDetailData?
    @State private var errorMessage: String?
    @State private var isLoading = true

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 20) {
                backChip.cascadeIn(delay: 0.04)
                header.cascadeIn(delay: 0.10)

                if isLoading {
                    loadingCard.cascadeIn(delay: 0.18)
                } else if let d = detail {
                    detailContent(d)
                } else if let err = errorMessage {
                    HubCard(theme: theme) {
                        HubEmptyState(icon: "exclamationmark.triangle", message: err, theme: theme)
                    }
                }
            }
            .padding(28)
        }
        .task(id: project.id) {
            await loadDetail()
        }
    }

    private var backChip: some View {
        Button(action: onBack) {
            HStack(spacing: 5) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 10, weight: .bold))
                Text("All projects")
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
            }
            .foregroundColor(c.accent)
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(
                Capsule()
                    .fill(c.accent.opacity(0.12))
                    .overlay(Capsule().stroke(c.accent.opacity(0.35), lineWidth: 1))
            )
        }
        .buttonStyle(.borderless)
        .keyboardShortcut(.escape, modifiers: [])
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(project.project)
                .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                .foregroundColor(bg.primaryTextColor)
                .lineLimit(2)
            HStack(spacing: 14) {
                Text(Fmt.cost(project.totalCost))
                    .font(.system(size: 13, weight: .semibold, design: theme.fonts.valueDesign))
                    .foregroundColor(c.highlight)
                Text("·").foregroundColor(bg.secondaryTextColor)
                Text("\(Fmt.number(project.totalTokens)) tokens")
                    .font(.system(size: 12, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                Text("·").foregroundColor(bg.secondaryTextColor)
                Text("\(project.activeDays) day\(project.activeDays == 1 ? "" : "s")")
                    .font(.system(size: 12, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
        }
    }

    @ViewBuilder
    private func detailContent(_ d: ProjectDetailData) -> some View {
        detailKpiRow(d).cascadeIn(delay: 0.18)
        dailyChartCard(d).cascadeIn(delay: 0.28)
        HStack(alignment: .top, spacing: 12) {
            HubCard(theme: theme) {
                HubProjectModelsList(models: d.models, theme: theme)
            }
            HubCard(theme: theme) {
                HubProjectProvidersList(providers: d.providers, theme: theme)
            }
        }
        .cascadeIn(delay: 0.38)
        HubProjectCliActions(projectName: project.project, theme: theme)
            .cascadeIn(delay: 0.46)
    }

    private func detailKpiRow(_ d: ProjectDetailData) -> some View {
        HStack(spacing: 12) {
            HubKpiTile(label: "Input", value: Fmt.number(d.inputTokens),
                       icon: "arrow.down.circle.fill", accent: c.secondary, theme: theme)
            HubKpiTile(label: "Output", value: Fmt.number(d.outputTokens),
                       icon: "arrow.up.circle.fill", accent: c.warm, theme: theme)
            HubKpiTile(label: "Cache read", value: Fmt.number(d.cacheReadTokens),
                       icon: "bolt.horizontal.fill", accent: c.accent, theme: theme)
            HubKpiTile(label: "Reasoning", value: Fmt.number(d.reasoningTokens),
                       icon: "brain.head.profile", accent: c.tertiary, theme: theme)
        }
    }

    private func dailyChartCard(_ d: ProjectDetailData) -> some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Daily activity")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    HubChartLegend(theme: theme)
                }
                HubActivityChart(
                    daily: d.dailyBreakdown.map {
                        DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost)
                    },
                    theme: theme
                )
                .frame(height: 190)
            }
        }
    }

    private var loadingCard: some View {
        HubCard(theme: theme) {
            VStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                Text("Loading project detail…")
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 28)
        }
    }

    private func loadDetail() async {
        isLoading = true
        errorMessage = nil
        do {
            let d = try await DaemonClient.shared.fetchProjectDetail(project.project)
            self.detail = d
            self.isLoading = false
        } catch {
            self.errorMessage = "Couldn't load detail: \(error.localizedDescription)"
            self.isLoading = false
        }
    }
}

/// Models list inside the detail view. Top 8 models with cost-share bars.
struct HubProjectModelsList: View {
    let models: [ModelDetail]
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Models")
                .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                .foregroundColor(bg.primaryTextColor)
            if models.isEmpty {
                HubEmptyState(icon: "cube", message: "No model data", theme: theme)
            } else {
                VStack(spacing: 8) {
                    ForEach(models.prefix(8)) { m in
                        modelRow(m)
                    }
                }
            }
        }
    }

    private func modelRow(_ m: ModelDetail) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack {
                Text(Fmt.shortModel(m.model))
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                Text(Fmt.cost(m.cost))
                    .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(bg.isLight ? 0.06 : 0.08))
                    Capsule()
                        .fill(
                            LinearGradient(
                                colors: [c.primary, c.secondary, c.warm],
                                startPoint: .leading, endPoint: .trailing
                            )
                        )
                        .frame(width: safeDim(geo.size.width * CGFloat(m.percentageOfTotal / 100.0), floor: 4))
                }
            }
            .frame(height: 5)
        }
    }
}

/// Providers list inside the detail view. Compact rows with cost + share.
struct HubProjectProvidersList: View {
    let providers: [ProviderDetail]
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Providers")
                .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                .foregroundColor(bg.primaryTextColor)
            if providers.isEmpty {
                HubEmptyState(icon: "antenna.radiowaves.left.and.right",
                              message: "No providers", theme: theme)
            } else {
                VStack(spacing: 6) {
                    ForEach(providers) { p in
                        providerRow(p)
                    }
                }
            }
        }
    }

    private func providerRow(_ p: ProviderDetail) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(c.secondary.opacity(0.7))
                .frame(width: 7, height: 7)
            Text(p.provider)
                .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("\(p.models.count) model\(p.models.count == 1 ? "" : "s")")
                .font(.system(size: 9, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
            Spacer()
            Text("\(Int(p.percentageOfTotal.rounded()))%")
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.secondaryTextColor)
            Text(Fmt.cost(p.cost))
                .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
        }
        .padding(.vertical, 3)
    }
}
