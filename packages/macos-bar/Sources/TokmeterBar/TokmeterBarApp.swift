// TokmeterBarApp.swift — App entry point.
//
// Uses SwiftUI's MenuBarExtra to put a small icon + cost indicator in the
// system menu bar. Clicking it opens the popover defined in TokmeterBarView.

import SwiftUI

@main
struct TokmeterBarApp: App {
    @StateObject private var loader = TokmeterLoader()
    @StateObject private var updater = UpdaterController()
    @ObservedObject private var config = HubConfigStore.shared

    init() {
        AppTheme.migrateStoredPreference()
        // Once-a-minute idle sampling for the late-night rest nudge.
        RestNudgeMonitor.shared.start()
    }

    var body: some Scene {
        MenuBarExtra {
            TokmeterBarView(loader: loader, updater: updater)
        } label: {
            Label {
                Text(costLabel)
            } icon: {
                Image(systemName: "infinity")
            }
            // Tint by the live health band when a source is active; the number
            // stays visible so color is never the only signal (accessibility).
            .foregroundStyle(menubarTint)
            .accessibilityLabel(accessibilityLabel)
        }
        .menuBarExtraStyle(.window)

        Window("Tokmeter Hub", id: "tokmeter-hub") {
            HubView(loader: loader)
                .frame(minWidth: 860, minHeight: 560)
        }
        .defaultSize(width: 980, height: 660)
        .windowResizability(.contentMinSize)
    }

    /// Text shown next to the SF Symbol. For live context/block sources it
    /// shows the % (the "how close to the cliff" signal); otherwise the cost.
    /// "?" when the daemon is unreachable and "…" while it starts or runs its
    /// first scan. Only a live daemon gets a number: the loader keeps the last
    /// fetched todayTokens through an outage, and before this the label kept
    /// showing them (yesterday's count after midnight, "0 tok" on a cold
    /// launch) because handleDaemonOffline clears lastError.
    private var costLabel: String {
        switch labelState {
        case .unavailable: return "?"
        case .starting: return "…"
        case .live: break
        }
        if let pct = activePct {
            return "\(Int(pct.rounded()))%"
        }
        return "\(Fmt.number(loader.todayTokens)) tok"
    }

    private enum LabelState { case live, starting, unavailable }

    private var labelState: LabelState {
        if loader.lastError != nil { return .unavailable }
        switch loader.daemonPhase {
        case .live: return .live
        case .warming: return .starting
        case .offline, .needsNode: return .unavailable
        }
    }

    /// The percentage for the selected live source, if it has data right now.
    private var activePct: Double? {
        switch config.config.colorSource {
        case .context: return loader.liveContextFillPct
        case .block: return loader.blockPct
        case .budget, .off: return nil
        }
    }

    /// The health band for the selected source, or nil when there's nothing to
    /// color (source off, or no data for the selected signal).
    private var menubarBand: HealthBand? {
        if labelState != .live { return nil }
        switch config.config.colorSource {
        case .off:
            return nil
        case .context:
            return loader.liveContextFillPct.map { HealthBand.forPct($0) }
        case .block:
            return loader.blockPct.map { HealthBand.forPct($0) }
        case .budget:
            guard let budget = config.config.alerts.dailyCostThreshold, budget > 0 else { return nil }
            return HealthBand.forPct(loader.todayCost / budget * 100)
        }
    }

    /// Menubar tint: the band color when a source is live, else the normal
    /// template appearance so the item looks native when coloring is off/idle.
    private var menubarTint: Color {
        menubarBand?.color ?? .primary
    }

    /// VoiceOver-friendly description of the menu bar label.
    private var accessibilityLabel: String {
        switch labelState {
        case .unavailable: return "Tokmeter: daemon offline"
        case .starting: return "Tokmeter: usage service starting"
        case .live: break
        }
        let base = "Tokmeter: \(Fmt.number(loader.todayTokens)) tokens today"
        guard let band = menubarBand, let pct = activePct else { return base }
        let sourceName: String
        switch config.config.colorSource {
        case .context: sourceName = "context fill"
        case .block: sourceName = "billing block"
        default: sourceName = "usage"
        }
        return "\(base). \(sourceName) \(Int(pct.rounded())) percent, \(band.accessibilityName)."
    }
}
