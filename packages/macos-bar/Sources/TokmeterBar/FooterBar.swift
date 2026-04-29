// FooterBar.swift — bottom strip of the popover with status + controls.
//
// Two rows:
//   1. Attribution ("Built by sriinnu · v0.4.0")
//   2. Live heartbeat dot + Refresh + Settings + Update + Quit
//
// The live heartbeat already exists in the hero as a richer ECG. Here we
// keep a compact dot-pulse to show the daemon is reachable even when the
// hero's ECG is off-screen during long scrolls.

import SwiftUI

struct FooterBar: View {
    @ObservedObject var loader: TokmeterLoader
    @ObservedObject var updater: UpdaterController
    /// Bound theme — mutable so the gear-popover can switch it via SettingsPopover.
    @Binding var theme: AppTheme
    @Binding var showSettings: Bool

    @Environment(\.openWindow) private var openWindow

    /// Refresh icon rotation — spins while `loader.isLoading` is true.
    @State private var refreshAngle: Double = 0

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.4.1"
    }

    var body: some View {
        VStack(spacing: 6) {
            attributionRow
            controlsRow
        }
    }

    private var attributionRow: some View {
        HStack(spacing: 4) {
            Text("Built by sriinnu")
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
                .onTapGesture {
                    NSWorkspace.shared.open(URL(string: "https://github.com/sriinnu")!)
                }
            Text("·")
                .font(.system(size: 10))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            Text("v\(appVersion)")
                .font(.system(size: 10, design: theme.fonts.bodyDesign))
                .foregroundColor(theme.backgroundMode.secondaryTextColor)
            Spacer()
            if loader.pricingMtime > 0 {
                Text("Pricing: \(relativeTime(loader.pricingMtime))")
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
                    .help("Last kosha registry fetch — older than 24h means today's reprice may be using stale rates.")
            }
        }
    }

    /// "2h ago" / "12m ago" / "just now" — single decimal precision is overkill
    /// for a footer badge, so we round down to the largest unit.
    private func relativeTime(_ mtimeMs: Double) -> String {
        let seconds = max(0, Date().timeIntervalSince1970 - mtimeMs / 1000.0)
        if seconds < 60 { return "just now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m ago" }
        if seconds < 86_400 { return "\(Int(seconds / 3600))h ago" }
        return "\(Int(seconds / 86_400))d ago"
    }

    private var controlsRow: some View {
        HStack(spacing: 10) {
            LiveHeartbeat(isAlive: loader.isDaemonAlive, theme: theme)

            Button(action: { Task { await loader.loadData() } }) {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.clockwise")
                        .rotationEffect(.degrees(refreshAngle))
                    Text(loader.isLoading ? "Refreshing…" : "Refresh")
                }
                .font(.system(size: 11, design: theme.fonts.bodyDesign))
            }
            .buttonStyle(.borderless)
            .foregroundColor(theme.backgroundMode.secondaryTextColor)
            .disabled(loader.isLoading)
            .keyboardShortcut("r", modifiers: [.command])
            .onChange(of: loader.isLoading) { _, isLoading in
                if isLoading {
                    // Continuous 0.9s/rev linear spin — `repeatForever` on a
                    // rotationEffect angle is the cheapest spinner SwiftUI offers.
                    withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                        refreshAngle = 360
                    }
                } else {
                    // Ease back to 0 so the icon settles rather than snapping.
                    withAnimation(.easeOut(duration: 0.25)) {
                        refreshAngle = 0
                    }
                }
            }

            Spacer()

            FooterIconButton(systemImage: "macwindow", theme: theme, help: "Open Hub (⌘H)") {
                openWindow(id: "tokmeter-hub")
            }
            .keyboardShortcut("h", modifiers: [.command])

            FooterIconButton(systemImage: "gearshape", theme: theme, help: "Settings") {
                showSettings.toggle()
            }
            .popover(isPresented: $showSettings) {
                SettingsPopover(theme: $theme, loader: loader)
            }

            FooterIconButton(systemImage: "arrow.down.circle",
                             theme: theme,
                             help: "Check for updates",
                             disabled: !updater.canCheckForUpdates) {
                updater.checkForUpdates()
            }

            FooterIconButton(systemImage: "power", theme: theme, help: "Quit Tokmeter") {
                NSApplication.shared.terminate(nil)
            }
        }
    }

}

/// Self-contained heartbeat indicator. Drives its own animation loop via
/// TimelineView so phase changes don't bubble up to FooterBar / TokmeterBarView,
/// which used to rebuild on every frame of the breath animation.
struct LiveHeartbeat: View {
    let isAlive: Bool
    let theme: AppTheme

    var body: some View {
        TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
            // 2-second-period sine wave normalized to [0, 1]. We sample analytically
            // every frame instead of holding @State that triggers re-renders.
            let t = timeline.date.timeIntervalSinceReferenceDate
            let phase = CGFloat(sin(t * .pi)) * 0.5 + 0.5
            HStack(spacing: 4) {
                ZStack {
                    if isAlive {
                        // Expanding ring — fades as it scales outward
                        Circle()
                            .stroke(Color.green.opacity(0.8 - 0.8 * Double(phase)), lineWidth: 1)
                            .frame(width: 7, height: 7)
                            .scaleEffect(1.0 + phase * 2.4)
                    }
                    Circle()
                        .fill(isAlive ? Color.green : Color.red)
                        .frame(width: 7, height: 7)
                        .shadow(color: isAlive ? .green.opacity(0.6) : .clear, radius: 4)
                        .scaleEffect(isAlive ? (1.0 + phase * 0.3) : 1.0)
                }
                .frame(width: 24, height: 24)
                Text(isAlive ? "Live" : "Offline")
                    .font(.system(size: 9, weight: .semibold, design: theme.fonts.bodyDesign))
                    .foregroundColor(isAlive ? .green : .red.opacity(0.8))
            }
        }
        .accessibilityLabel(isAlive ? "Daemon running" : "Daemon offline")
    }
}

/// Compact icon-only button for the footer with a consistent hover lift +
/// brightness response. Extracted so each button has its own @State and only
/// the hovered button re-renders, not the whole footer row.
struct FooterIconButton: View {
    let systemImage: String
    let theme: AppTheme
    let help: String
    var disabled: Bool = false
    let action: () -> Void

    @State private var hovered: Bool = false

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 12))
                .foregroundColor(
                    hovered ? theme.colors.accent : theme.backgroundMode.secondaryTextColor
                )
                .scaleEffect(hovered ? 1.10 : 1.0)
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .help(help)
        .onHover { hovered = !disabled && $0 }
        .animation(.spring(response: 0.30, dampingFraction: 0.72), value: hovered)
    }
}
