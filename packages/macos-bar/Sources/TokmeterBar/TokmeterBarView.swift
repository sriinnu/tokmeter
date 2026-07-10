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
    /// Tracks whether this popover's window is actually on screen — see
    /// PanelVisibility.swift. Every ambient animation in the hero/footer is
    /// gated on this so they stop burning CPU while the panel is closed.
    @StateObject private var panelVisibility = PanelVisibility()
    @State private var showSettings = false
    /// Drives the cache "wallet" slide-out drawer. Toggled by the wallet icon
    /// in the hero header; the drawer renders as a trailing-edge overlay.
    @State private var showCachePanel = false
    /// Drives the pricing-anomaly drill-in as a popover-wide overlay (not a
    /// .sheet — sheets from a MenuBarExtra popover have flaky event handling).
    @State private var showAnomalyPanel = false
    /// Top-anchored gradient ripple flashed briefly on theme change so the
    /// transition reads as deliberate, not a glitch.
    @State private var themeRipple: Bool = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HeroHeader(
                loader: loader,
                theme: theme,
                breathToggle: breathToggle,
                isVisible: panelVisibility.isVisible,
                showCachePanel: $showCachePanel
            )
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
                    // CACHE & CONTEXT is no longer inline — it lives in the
                    // wallet drawer, opened from the hero header icon.
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
                showSettings: $showSettings,
                showAnomalyPanel: $showAnomalyPanel,
                isVisible: panelVisibility.isVisible
            )
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .cascadeIn(delay: 0.46)
        }
        .frame(width: 400)
        .frame(minHeight: 620, maxHeight: 820)
        .background(popoverBackground)
        .trackPanelVisibility(panelVisibility)
        // Cache "wallet" drawer — slides in from the trailing edge over the
        // whole popover when the hero header's wallet icon is tapped.
        .overlay {
            if showCachePanel, let signals = loader.statbarSignals {
                CacheWalletDrawer(signals: signals, theme: theme, isPresented: $showCachePanel)
                    .zIndex(10)
            }
        }
        // Pricing-anomaly drill-in — an in-popover overlay (NOT a .sheet, whose
        // Close needed repeated clicks from a MenuBarExtra popover). Tap the
        // dimmed backdrop anywhere to dismiss; the card's own ✕/Esc also work
        // because it's in the popover's own view hierarchy now.
        .overlay {
            if showAnomalyPanel, let anomalies = loader.pricingAnomalies {
                ZStack {
                    Color.black.opacity(0.38)
                        .contentShape(Rectangle())
                        .onTapGesture { showAnomalyPanel = false }
                    AnomalyDetailSheet(response: anomalies, theme: theme, isPresented: $showAnomalyPanel)
                        .clipShape(RoundedRectangle(cornerRadius: 14))
                        .shadow(color: .black.opacity(0.35), radius: 24, y: 8)
                        .padding(12)
                }
                .zIndex(20)
                .transition(.opacity)
            }
        }
        .animation(.spring(response: 0.45, dampingFraction: 0.82), value: showCachePanel)
        .animation(.easeInOut(duration: 0.2), value: showAnomalyPanel)
        // Close the anomaly overlay if its data disappears OR ages to zero
        // (daemon restart, transient fetch failure, or all anomalies falling out
        // of the 24h window) so it never lingers showing "0 movements".
        .onChange(of: (loader.pricingAnomalies?.total ?? 0) == 0) { _, isEmpty in
            if isEmpty && showAnomalyPanel { showAnomalyPanel = false }
        }
        // If signals disappear while the drawer is open (daemon restart, brief
        // /api/statbar-signals failure), the overlay's `if let` clause silently
        // unmounts the drawer but `showCachePanel` stays true. When signals
        // return on the next poll, the drawer would pop back unexpectedly —
        // the user already moved on. Close the drawer when signals go nil so
        // intent matches state.
        .onChange(of: loader.statbarSignals == nil) { _, signalsAreNil in
            if signalsAreNil && showCachePanel {
                showCachePanel = false
            }
        }
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
        // NOT just `breathToggle = visible` — every `.animation(curve.repeatForever(...),
        // value: breathToggle)` site (hero pulse, shimmer bars, glow scale effects,
        // ~a dozen call sites across HeroHeader/HeroBackground/SharedViews) restarts
        // its OWN infinite Core Animation loop on ANY change to breathToggle, not just
        // the first. A plain assignment on hide would kick off a brand-new repeatForever
        // loop breathing toward the "off" resting values — reproducing this exact CPU
        // bug one open/close cycle after "fixing" it. Wrapping the hide transition in a
        // disablesAnimations transaction makes every one of those .animation modifiers
        // skip its curve for this specific change: the value snaps to false with no
        // animation ever entered, so no loop starts. The show transition uses the
        // ambient (animated) transaction as normal, so breathing resumes on reopen.
        .onChange(of: panelVisibility.isVisible, initial: true) { _, visible in
            if visible {
                breathToggle = true
            } else {
                var t = Transaction()
                t.disablesAnimations = true
                withTransaction(t) {
                    breathToggle = false
                }
            }
        }
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

}
