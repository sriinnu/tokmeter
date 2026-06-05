// HubView.swift — the full-size "Hub" window.
//
// Opened from the bar's footer, this is the native Mac surface where the user
// explores everything the bar only hints at: per-project drilldown, charts,
// command reference, settings. Shares the same TokmeterLoader as the bar so
// both surfaces refresh off a single timer.
//
// Skeleton phase: sidebar + empty section panels. Data wiring, charts, and
// project drilldown land in follow-up commits. Everything here is themed
// against the same AppTheme the bar uses.

import SwiftUI

/// Which panel is currently shown in the hub's detail area.
enum HubSection: String, CaseIterable, Identifiable {
    case overview
    case projects
    case commands
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .overview: return "Overview"
        case .projects: return "Projects"
        case .commands: return "Commands"
        case .settings: return "Settings"
        }
    }

    var icon: String {
        switch self {
        case .overview: return "chart.bar.doc.horizontal"
        case .projects: return "folder.fill"
        case .commands: return "terminal.fill"
        case .settings: return "gearshape.fill"
        }
    }

    var tagline: String {
        switch self {
        case .overview: return "Totals, activity, top movers"
        case .projects: return "Drill into one project"
        case .commands: return "Every CLI command, copied"
        case .settings: return "Theme, refresh, thresholds"
        }
    }
}

/// The hub window's content root. Holds the selected section and lays out the
/// sidebar + detail panels inside a NavigationSplitView.
struct HubView: View {
    @ObservedObject var loader: TokmeterLoader

    /// Same @AppStorage key as the bar — picking a theme in either surface
    /// retints the other instantly.
    @AppStorage("appTheme") var theme: AppTheme = .nebula

    @State private var selection: HubSection = .overview

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        // A plain HStack sidebar+detail, NOT a NavigationSplitView. The split view's
        // internal AppKit Auto-Layout machinery (divider/column constraints, bridged
        // through NSHostingView) re-enters the window's Update-Constraints pass at
        // large window sizes and never converges → "more Update Constraints passes
        // than there are views in the window". A fixed-width sidebar + greedy detail
        // in an HStack has no divider negotiation and no split-view constraint graph,
        // so the loop has nowhere to live. Fixed 232pt sidebar matches the prior
        // pinned column.
        HStack(spacing: 0) {
            HubSidebar(selection: $selection, loader: loader, theme: theme)
                .frame(width: 232)
                .frame(maxHeight: .infinity)
                .background(sidebarBackground)
            Divider()
                .ignoresSafeArea()
            detailPanel
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(hubBackground)
        }
        .preferredColorScheme(bg.isLight ? .light : .dark)
    }

    // MARK: - Detail panel switching

    // Panel switching is a plain `.id`-keyed swap — NO `.transition` here and NO
    // `.animation(value: selection)` on the NavigationSplitView (see body). An
    // implicit animation on a NavigationSplitView tries to animate the split
    // view's own AppKit Auto Layout constraints; combined with a `.transition`
    // on `.id`-keyed detail content it re-enters the window's Update-Constraints
    // pass without converging and AppKit throws "more Update Constraints passes
    // than there are views in the window", crashing on *every* navigation.
    // Each panel still animates its own entrance via `cascadeIn`, so the staged
    // fade-in stays — only the crashing split-view-level animation is gone.
    @ViewBuilder
    private var detailPanel: some View {
        switch selection {
        case .overview:
            HubOverviewPanel(loader: loader, theme: theme).id(HubSection.overview)
        case .projects:
            HubProjectsPanel(loader: loader, theme: theme).id(HubSection.projects)
        case .commands:
            HubCommandsPanel(theme: theme).id(HubSection.commands)
        case .settings:
            HubSettingsPanel(loader: loader, theme: $theme).id(HubSection.settings)
        }
    }

    // MARK: - Backgrounds

    /// Sidebar paints a slightly darker variant of the main surface so the
    /// split reads as intentional, not a matte seam.
    @ViewBuilder
    private var sidebarBackground: some View {
        if bg.usesMaterial {
            Rectangle().fill(.thinMaterial)
        } else {
            LinearGradient(
                colors: [
                    bg.surfaceColor.opacity(bg.isLight ? 1.0 : 0.90),
                    bg.surfaceColor.opacity(bg.isLight ? 0.92 : 0.75),
                ],
                startPoint: .top, endPoint: .bottom
            )
        }
    }

    /// Main detail surface — gradient variant of the theme background so the
    /// hub reads as one continuous surface with the bar.
    @ViewBuilder
    private var hubBackground: some View {
        if bg.usesMaterial {
            ZStack {
                Rectangle().fill(.regularMaterial)
                LinearGradient(
                    colors: bg.gradientColors(),
                    startPoint: .top, endPoint: .bottom
                )
            }
        } else {
            LinearGradient(
                colors: bg.gradientColors(),
                startPoint: .top, endPoint: .bottom
            )
        }
    }
}
