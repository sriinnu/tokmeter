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
        NavigationSplitView {
            HubSidebar(selection: $selection, theme: theme)
                .frame(minWidth: 200, idealWidth: 220)
                .background(sidebarBackground)
        } detail: {
            detailPanel
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(hubBackground)
        }
        .navigationSplitViewStyle(.balanced)
        .preferredColorScheme(bg.isLight ? .light : .dark)
        // Pixar-spring sensibility: visible overshoot, things land with weight.
        // Lower damping = more bounce. 0.62 is right at the edge of playful
        // without looking buggy.
        .animation(.spring(response: 0.55, dampingFraction: 0.62), value: selection)
        .animation(.spring(response: 0.55, dampingFraction: 0.72), value: theme)
    }

    // MARK: - Detail panel switching

    @ViewBuilder
    private var detailPanel: some View {
        switch selection {
        case .overview:
            HubOverviewPanel(loader: loader, theme: theme)
                .id(HubSection.overview)
                .transition(panelTransition)
        case .projects:
            HubProjectsPanel(loader: loader, theme: theme)
                .id(HubSection.projects)
                .transition(panelTransition)
        case .commands:
            HubCommandsPanel(theme: theme)
                .id(HubSection.commands)
                .transition(panelTransition)
        case .settings:
            HubSettingsPanel(loader: loader, theme: $theme)
                .id(HubSection.settings)
                .transition(panelTransition)
        }
    }

    /// Pixar-style panel entry — scales up from slightly small with a bouncy
    /// overshoot so each section "lands" on arrival rather than slides flat.
    private var panelTransition: AnyTransition {
        .asymmetric(
            insertion: .scale(scale: 0.94).combined(with: .opacity),
            removal: .scale(scale: 1.02).combined(with: .opacity)
        )
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
