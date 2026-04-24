// TokmeterBarView.swift — top-level composition of the menubar popover.
//
// Layout, top to bottom:
//
//   ┌──────────────── HeroHeader ──────────────────┐
//   │  ♾️ TOKMETER              [live ECG trace]    │
//   │  $48.95  today                                │
//   └──────────────────────────────────────────────┘
//        (optional error banner inline)
//   ┌── ScrollView ─────────────────────────────────┐
//   │  StatsGrid (3 KPI cards with sparklines)      │
//   │  ModelsSection (top model bars)               │
//   │  WeekSection (7-day line chart)               │
//   │  SessionsSection (per-project rows)           │
//   └──────────────────────────────────────────────┘
//   Divider
//   FooterBar (Live dot, Refresh, Settings, Update, Quit)
//
// This file is intentionally thin — actual rendering lives in the per-section
// files. Here we only wire state, provide the popover chrome, and pass
// theme + loader down to children.

import SwiftUI

struct TokmeterBarView: View {
    @ObservedObject var loader: TokmeterLoader
    @ObservedObject var updater: UpdaterController

    /// Persisted theme. `@AppStorage` means picker changes survive app restarts.
    @AppStorage("appTheme") var theme: AppTheme = .nebula

    /// Local UI state — never persisted.
    @State private var showAllSessions = false
    @State private var breathToggle = false
    @State private var heartbeatPhase: CGFloat = 0
    @State private var showSettings = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HeroHeader(loader: loader, theme: theme, breathToggle: breathToggle)

            errorBanner
                .padding(.horizontal, 16)
                .padding(.top, 8)

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 16) {
                    StatsGrid(loader: loader, theme: theme)
                    if !loader.topModels.isEmpty || loader.isWarming {
                        ModelsSection(loader: loader, theme: theme)
                    }
                    if loader.recentDaily.count > 1 || loader.isWarming {
                        WeekSection(loader: loader, theme: theme)
                    }
                    if !loader.sessions.isEmpty || loader.isWarming {
                        SessionsSection(loader: loader, theme: theme, showAll: $showAllSessions)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 10)
            }

            Divider().opacity(0.3)

            FooterBar(
                loader: loader,
                updater: updater,
                theme: $theme,
                heartbeatPhase: heartbeatPhase,
                showSettings: $showSettings
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
        .frame(width: 400)
        .frame(minHeight: 620, maxHeight: 820)
        .background(popoverBackground)
        // Force the color scheme to match the theme's surface so built-in
        // SwiftUI chrome (Divider, .secondary, system sheets) reads correctly.
        .preferredColorScheme(bg.isLight ? .light : .dark)
        .onAppear(perform: startAmbientAnimations)
    }

    // MARK: - Background

    /// Solid/gradient for most themes; a translucent material stack for Glass
    /// so the desktop wallpaper bleeds through.
    @ViewBuilder
    private var popoverBackground: some View {
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

    // MARK: - Error banner

    /// Rendered between the hero and the scroll area. Shows a friendly
    /// collapsed form of the daemon error when there is one AND we're not
    /// still warming up (during warming, the error is normal transient noise).
    @ViewBuilder
    private var errorBanner: some View {
        if let error = loader.lastError, !loader.isWarming {
            HStack(spacing: 6) {
                Image(systemName: "bolt.trianglebadge.exclamationmark.fill")
                    .foregroundColor(.orange)
                    .font(.system(size: 12))
                Text(Fmt.shortError(error))
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundColor(.primary.opacity(0.8))
                    .lineLimit(1)
                    .help(error)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(Capsule().fill(Color.orange.opacity(0.12)))
            .padding(.bottom, 4)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Animations

    /// Kick off the two looping state machines that drive breath + heartbeat
    /// across the whole popover. These live on the parent so children share
    /// a common rhythm instead of each starting their own timers.
    private func startAmbientAnimations() {
        breathToggle = true
        withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
            heartbeatPhase = 1
        }
    }
}
