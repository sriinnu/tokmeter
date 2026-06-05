// HubProjectDetail.swift — the Hub's Projects tab (panel + list view).
//
// Two modes, toggled by a @State project selection. The detail view lives
// in HubProjectDetailView.swift (in this same module); this file keeps the
// list, the sort pills, and the panel root that switches between them.
// Transitions lean pixar-springy on both directions so the two modes feel
// like one navigation rather than two panels swapping.

import AppKit
import SwiftUI

// ─── Panel root ───────────────────────────────────────────────────────────

struct HubProjectsPanel: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    /// The project currently expanded to detail. Nil = list view.
    @State private var selected: ProjectData?

    var body: some View {
        // The list↔detail swap is a plain, UNANIMATED `.id`-keyed change. Wrapping
        // a structural swap (different identity, a whole detail subtree with its own
        // GeometryReaders appearing) in `withAnimation` / `.transition` makes AppKit
        // re-enter the window's Update-Constraints pass without converging — the
        // "more Update Constraints passes than there are views in the window" crash.
        // Property animations (hover, scale) on stable views are fine; structural
        // swaps must not be animated. Each side still fades its content in via
        // `cascadeIn`, so the drill-in/out still feels alive.
        Group {
            if let project = selected {
                HubProjectDetailView(
                    project: project,
                    theme: theme,
                    onBack: { selected = nil }
                )
                .id("detail-\(project.id)")
            } else {
                HubProjectsList(
                    projects: loader.sessions,
                    theme: theme,
                    onSelect: { proj in selected = proj }
                )
                .id("list")
            }
        }
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

    private var sortPills: some View {
        HStack(spacing: 8) {
            ForEach(ProjectSort.allCases) { opt in
                HubSortPill(
                    option: opt,
                    isSelected: sort == opt,
                    theme: theme
                ) {
                    // Re-sorting reorders up to 50 rows; animating that structural
                    // change re-enters the constraint pass. Keep it instant.
                    sort = opt
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
