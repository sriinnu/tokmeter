// HubProjectDetail.swift — the Hub's Projects tab.
//
// Two modes, toggled by a @State project selection:
//
//   LIST    — all projects, sortable by cost or recency. Rich rows with
//             rank, name, active-days, cost. Click a row → drilldown.
//   DETAIL  — one project expanded: header stats, daily chart, model
//             breakdown, provider split, and a CLI action row that
//             copies pre-filled commands to the clipboard for cleanup,
//             snapshot, alias, etc. A "Back" chip returns to the list.
//
// Transitions lean pixar-springy on both directions so the two modes feel
// like one navigation rather than two panels swapping.

import AppKit
import Charts
import SwiftUI

// ─── Panel root ───────────────────────────────────────────────────────────

struct HubProjectsPanel: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    /// The project currently expanded to detail. Nil = list view.
    @State private var selected: ProjectData?

    var body: some View {
        Group {
            if let project = selected {
                HubProjectDetailView(
                    project: project,
                    theme: theme,
                    onBack: { selected = nil }
                )
                .id("detail-\(project.id)")
                .transition(
                    .asymmetric(
                        insertion: .move(edge: .trailing).combined(with: .opacity),
                        removal: .move(edge: .trailing).combined(with: .opacity)
                    )
                )
            } else {
                HubProjectsList(
                    projects: loader.sessions,
                    theme: theme,
                    onSelect: { selected = $0 }
                )
                .id("list")
                .transition(
                    .asymmetric(
                        insertion: .move(edge: .leading).combined(with: .opacity),
                        removal: .move(edge: .leading).combined(with: .opacity)
                    )
                )
            }
        }
        .animation(.spring(response: 0.50, dampingFraction: 0.70), value: selected?.id)
    }
}

// ─── List view ────────────────────────────────────────────────────────────

/// How the list is sorted. Toggled by the header pill.
enum ProjectSort: String, CaseIterable, Identifiable {
    case cost
    case recency
    case activeDays

    var id: String { rawValue }
    var label: String {
        switch self {
        case .cost:       return "By cost"
        case .recency:    return "By recency"
        case .activeDays: return "By days active"
        }
    }
    var icon: String {
        switch self {
        case .cost:       return "dollarsign.circle"
        case .recency:    return "clock"
        case .activeDays: return "calendar"
        }
    }
}

struct HubProjectsList: View {
    let projects: [ProjectData]
    let theme: AppTheme
    let onSelect: (ProjectData) -> Void

    @State private var sort: ProjectSort = .cost

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private var sorted: [ProjectData] {
        switch sort {
        case .cost:       return projects.sorted { $0.totalCost > $1.totalCost }
        case .recency:    return projects.sorted { ($0.lastUsed ?? 0) > ($1.lastUsed ?? 0) }
        case .activeDays: return projects.sorted { $0.activeDays > $1.activeDays }
        }
    }

    var body: some View {
        ScrollView(.vertical, showsIndicators: true) {
            VStack(alignment: .leading, spacing: 20) {
                header.cascadeIn(delay: 0.06)
                sortPills.cascadeIn(delay: 0.12)
                projectsCard.cascadeIn(delay: 0.20)
            }
            .padding(28)
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Projects")
                .font(.system(size: 24, weight: .bold, design: theme.fonts.heroDesign))
                .foregroundColor(bg.primaryTextColor)
            Text("\(projects.count) project\(projects.count == 1 ? "" : "s") — click one to drill in.")
                .font(.system(size: 12, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
        }
    }

    /// Three-pill sort toggle. Spring-pops the selected state on change.
    private var sortPills: some View {
        HStack(spacing: 8) {
            ForEach(ProjectSort.allCases) { opt in
                HubSortPill(
                    option: opt,
                    isSelected: sort == opt,
                    theme: theme
                ) {
                    withAnimation(.spring(response: 0.40, dampingFraction: 0.62)) {
                        sort = opt
                    }
                }
            }
            Spacer()
        }
    }

    private var projectsCard: some View {
        HubCard(theme: theme) {
            if sorted.isEmpty {
                HubEmptyState(icon: "folder", message: "No projects yet", theme: theme)
            } else {
                VStack(spacing: 4) {
                    ForEach(Array(sorted.enumerated()), id: \.element.id) { idx, p in
                        HubProjectListRow(
                            rank: idx + 1,
                            project: p,
                            theme: theme,
                            onTap: { onSelect(p) }
                        )
                    }
                }
            }
        }
    }
}

struct HubSortPill: View {
    let option: ProjectSort
    let isSelected: Bool
    let theme: AppTheme
    let onTap: () -> Void

    @State private var hovered = false
    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 5) {
                Image(systemName: option.icon)
                    .font(.system(size: 10, weight: .semibold))
                Text(option.label)
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
            }
            .foregroundColor(
                isSelected ? .white : bg.primaryTextColor.opacity(0.75)
            )
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule()
                    .fill(
                        isSelected
                            ? AnyShapeStyle(
                                LinearGradient(
                                    colors: [c.primary, c.secondary],
                                    startPoint: .leading, endPoint: .trailing
                                )
                            )
                            : AnyShapeStyle(Color.primary.opacity(hovered ? 0.08 : 0.05))
                    )
                    .overlay(
                        Capsule().stroke(
                            isSelected ? c.accent.opacity(0.45) : Color.clear,
                            lineWidth: 1
                        )
                    )
            )
        }
        .buttonStyle(.borderless)
        .scaleEffect(isSelected ? 1.04 : (hovered ? 1.02 : 1.0))
        .animation(.spring(response: 0.32, dampingFraction: 0.60), value: isSelected)
        .animation(.spring(response: 0.28, dampingFraction: 0.72), value: hovered)
        .onHover { hovered = $0 }
    }
}

struct HubProjectListRow: View {
    let rank: Int
    let project: ProjectData
    let theme: AppTheme
    let onTap: () -> Void

    @State private var hovered = false
    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 12) {
                Text("\(rank)")
                    .font(.system(size: 10, weight: .bold, design: theme.fonts.labelDesign))
                    .foregroundColor(c.accent)
                    .frame(width: 20, alignment: .leading)

                Image(systemName: "folder.fill")
                    .font(.system(size: 12))
                    .foregroundColor(c.secondary.opacity(0.85))

                VStack(alignment: .leading, spacing: 2) {
                    Text(project.project)
                        .font(.system(size: 12, weight: .semibold, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.primaryTextColor)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    Text("\(project.activeDays) day\(project.activeDays == 1 ? "" : "s") · \(Fmt.number(project.totalTokens)) tokens")
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                }
                Spacer()
                Text(Fmt.cost(project.totalCost))
                    .font(.system(size: 13, weight: .bold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
                Image(systemName: "chevron.right")
                    .font(.system(size: 9, weight: .bold))
                    .foregroundColor(bg.secondaryTextColor)
                    .opacity(hovered ? 1 : 0.5)
                    .offset(x: hovered ? 2 : 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 9)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(hovered ? Color.primary.opacity(bg.isLight ? 0.06 : 0.08) : Color.clear)
            )
            .scaleEffect(hovered ? 1.005 : 1.0)
        }
        .buttonStyle(.borderless)
        .animation(.spring(response: 0.30, dampingFraction: 0.72), value: hovered)
        .onHover { hovered = $0 }
    }
}

// ─── Detail view ──────────────────────────────────────────────────────────

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

    // MARK: - Sections

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

    // MARK: - Fetch

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

// ─── Models list inside detail ────────────────────────────────────────────

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
                        .frame(width: max(4, geo.size.width * CGFloat(m.percentageOfTotal / 100.0)))
                }
            }
            .frame(height: 5)
        }
    }
}

// ─── Providers list inside detail ─────────────────────────────────────────

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

// ─── CLI action card (copy pre-filled commands) ───────────────────────────

/// Row of copy-to-clipboard CLI commands keyed to the current project. Each
/// row renders the command, a short explanation, and a copy button that
/// briefly flashes "Copied" for feedback.
struct HubProjectCliActions: View {
    let projectName: String
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// Which row just fired "Copied" feedback — used to animate the pill
    /// on the clicked button only, not every row.
    @State private var flashed: String?

    private var commands: [CliCommand] {
        let name = projectName
        return [
            CliCommand(
                id: "dry-run",
                icon: "trash.circle",
                title: "Preview cleanup",
                command: #"tokmeter cleanup --project "\#(name)" --dry-run"#
            ),
            CliCommand(
                id: "snapshot",
                icon: "archivebox",
                title: "Snapshot project",
                command: #"tokmeter snapshot --project "\#(name)""#
            ),
            CliCommand(
                id: "alias-rename",
                icon: "character.cursor.ibeam",
                title: "Rename via alias",
                command: #"tokmeter alias set "\#(name)" "Better Name""#
            ),
            CliCommand(
                id: "alias-hide",
                icon: "eye.slash",
                title: "Hide from tables",
                command: #"tokmeter alias hide "\#(name)""#
            ),
        ]
    }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 6) {
                    Image(systemName: "terminal.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(c.accent)
                    Text("Manage in terminal")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    Text("click to copy")
                        .font(.system(size: 9, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                }
                VStack(spacing: 6) {
                    ForEach(commands) { cmd in
                        cliRow(cmd)
                    }
                }
            }
        }
    }

    private func cliRow(_ cmd: CliCommand) -> some View {
        HubCliCommandRow(
            command: cmd,
            theme: theme,
            isFlashed: flashed == cmd.id,
            onCopy: {
                copyToClipboard(cmd.command)
                flashed = cmd.id
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                    if flashed == cmd.id { flashed = nil }
                }
            }
        )
    }

    private func copyToClipboard(_ s: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(s, forType: .string)
    }
}

struct CliCommand: Identifiable {
    let id: String
    let icon: String
    let title: String
    let command: String
}

struct HubCliCommandRow: View {
    let command: CliCommand
    let theme: AppTheme
    let isFlashed: Bool
    let onCopy: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        Button(action: onCopy) {
            HStack(spacing: 10) {
                Image(systemName: command.icon)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(c.accent)
                    .frame(width: 16)
                VStack(alignment: .leading, spacing: 2) {
                    Text(command.title)
                        .font(.system(size: 11, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Text(command.command)
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(bg.secondaryTextColor)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer()
                ZStack {
                    // Base "copy" icon — hidden while flashed.
                    Image(systemName: "doc.on.doc")
                        .opacity(isFlashed ? 0 : (hovered ? 1.0 : 0.55))
                    // "Copied ✓" pill flashes in when a copy fires.
                    if isFlashed {
                        Text("Copied")
                            .font(.system(size: 9, weight: .bold, design: theme.fonts.labelDesign))
                            .foregroundColor(.white)
                            .padding(.horizontal, 7)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(c.accent))
                            .transition(.scale(scale: 0.6).combined(with: .opacity))
                    }
                }
                .foregroundColor(bg.secondaryTextColor)
                .font(.system(size: 11, weight: .semibold))
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 7)
                    .fill(hovered ? Color.primary.opacity(bg.isLight ? 0.05 : 0.07) : Color.clear)
                    .overlay(
                        RoundedRectangle(cornerRadius: 7)
                            .stroke(hovered ? c.accent.opacity(0.25) : Color.clear, lineWidth: 1)
                    )
            )
            .scaleEffect(hovered ? 1.005 : 1.0)
        }
        .buttonStyle(.borderless)
        .animation(.spring(response: 0.30, dampingFraction: 0.70), value: hovered)
        .animation(.spring(response: 0.45, dampingFraction: 0.55), value: isFlashed)
        .onHover { hovered = $0 }
        .help("Copy: \(command.command)")
    }
}
