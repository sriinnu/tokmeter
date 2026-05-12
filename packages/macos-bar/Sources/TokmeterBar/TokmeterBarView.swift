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
    @State private var showSettings = false
    /// Top-anchored gradient ripple flashed briefly on theme change so the
    /// transition reads as deliberate, not a glitch.
    @State private var themeRipple: Bool = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HeroHeader(loader: loader, theme: theme, breathToggle: breathToggle)
                .cascadeIn(delay: 0.02)

            errorBanner
                .padding(.horizontal, 16)
                .padding(.top, 8)
                .cascadeIn(delay: 0.08)

            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 16) {
                    // Thin "right now" telemetry strip — burn rate, cache hit,
                    // compaction tax. Self-hides when there's no live signal.
                    SignalsRibbon(loader: loader, theme: theme)
                        .cascadeIn(delay: 0.10)
                    StatsGrid(loader: loader, theme: theme)
                        .cascadeIn(delay: 0.14)
                    if !loader.topModels.isEmpty || loader.isWarming {
                        ModelsSection(loader: loader, theme: theme)
                            .cascadeIn(delay: 0.22)
                    }
                    if loader.recentDaily.count > 1 || loader.isWarming {
                        WeekSection(loader: loader, theme: theme)
                            .cascadeIn(delay: 0.30)
                    }
                    if !loader.sessions.isEmpty || loader.isWarming {
                        SessionsSection(loader: loader, theme: theme, showAll: $showAllSessions)
                            .cascadeIn(delay: 0.38)
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
                showSettings: $showSettings
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .cascadeIn(delay: 0.46)
        }
        .frame(width: 400)
        .frame(minHeight: 620, maxHeight: 820)
        .background(popoverBackground)
        // Theme-switch ripple — a top-anchored gradient that flashes the new
        // theme's primary/secondary down from the menubar edge. Hint that the
        // change was real and intentional, not a render glitch.
        .overlay(alignment: .top) {
            LinearGradient(
                colors: [
                    c.primary.opacity(0.55),
                    c.secondary.opacity(0.30),
                    Color.clear,
                ],
                startPoint: .top, endPoint: .bottom
            )
            .frame(height: 240)
            .opacity(themeRipple ? 1 : 0)
            .allowsHitTesting(false)
        }
        // Animate theme color updates throughout the tree.
        .animation(.spring(response: 0.50, dampingFraction: 0.82), value: theme)
        // Force the color scheme to match the theme's surface so built-in
        // SwiftUI chrome (Divider, .secondary, system sheets) reads correctly.
        .preferredColorScheme(bg.isLight ? .light : .dark)
        .onAppear(perform: startAmbientAnimations)
        .onChange(of: theme) { _, _ in
            // Briefly flash the ripple, then fade it out smoothly.
            themeRipple = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.30) {
                withAnimation(.easeOut(duration: 0.55)) { themeRipple = false }
            }
        }
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
    /// Slides down from above with a spring when it first appears.
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
            .transition(
                .asymmetric(
                    insertion: .move(edge: .top).combined(with: .opacity),
                    removal: .move(edge: .top).combined(with: .opacity)
                )
            )
            .animation(.spring(response: 0.5, dampingFraction: 0.78), value: loader.lastError)
        }
    }

    // MARK: - Animations

    /// Kick off the slow breath cycle that hero ambient motion (gradient
    /// breathing, sun pulse, glass shimmer, etc.) reads from. The footer's
    /// LiveHeartbeat now drives its own TimelineView so we don't need a
    /// repeatForever timer on parent state anymore.
    private func startAmbientAnimations() {
        breathToggle = true
    }
}
