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
    /// Falls back to "?" when the daemon is offline.
    private var costLabel: String {
        if loader.lastError != nil {
            return "?"
        }
        if let pct = activePct {
            return "\(Int(pct.rounded()))%"
        }
        return String(format: "$%.2f", loader.todayCost)
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
        if loader.lastError != nil { return nil }
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
        if loader.lastError != nil {
            return "Tokmeter: daemon offline"
        }
        let base = String(format: "Tokmeter: today's cost is $%.2f", loader.todayCost)
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
