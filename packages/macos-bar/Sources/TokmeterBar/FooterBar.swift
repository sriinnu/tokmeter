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
    /// Slow heartbeat phase shared with the parent's breathing animations.
    let heartbeatPhase: CGFloat
    @Binding var showSettings: Bool

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.4.0"
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
        }
    }

    private var controlsRow: some View {
        HStack(spacing: 10) {
            heartbeat

            Button(action: { Task { await loader.loadData() } }) {
                Label(loader.isLoading ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                    .font(.system(size: 11, design: theme.fonts.bodyDesign))
            }
            .buttonStyle(.borderless)
            .foregroundColor(theme.backgroundMode.secondaryTextColor)
            .disabled(loader.isLoading)

            Spacer()

            Button(action: { showSettings.toggle() }) {
                Image(systemName: "gearshape").font(.system(size: 12))
            }
            .buttonStyle(.borderless)
            .foregroundColor(theme.backgroundMode.secondaryTextColor)
            .help("Settings")
            .popover(isPresented: $showSettings) {
                SettingsPopover(theme: $theme)
            }

            Button(action: { updater.checkForUpdates() }) {
                Image(systemName: "arrow.down.circle").font(.system(size: 12))
            }
            .buttonStyle(.borderless)
            .foregroundColor(theme.backgroundMode.secondaryTextColor)
            .disabled(!updater.canCheckForUpdates)
            .help("Check for updates")

            Button(action: { NSApplication.shared.terminate(nil) }) {
                Image(systemName: "power").font(.system(size: 12))
            }
            .buttonStyle(.borderless)
            .foregroundColor(theme.backgroundMode.secondaryTextColor)
            .help("Quit Tokmeter")
        }
    }

    /// Small green pulse + "Live" label. Scales with the shared heartbeatPhase.
    private var heartbeat: some View {
        let isAlive = loader.isDaemonAlive
        return HStack(spacing: 4) {
            Circle()
                .fill(isAlive ? Color.green : Color.red)
                .frame(width: 7, height: 7)
                .shadow(color: isAlive ? .green.opacity(0.6) : .clear, radius: 4)
                .scaleEffect(isAlive ? (1.0 + heartbeatPhase * 0.3) : 1.0)
            Text(isAlive ? "Live" : "Offline")
                .font(.system(size: 9, weight: .semibold, design: theme.fonts.bodyDesign))
                .foregroundColor(isAlive ? .green : .red.opacity(0.8))
        }
    }

}
