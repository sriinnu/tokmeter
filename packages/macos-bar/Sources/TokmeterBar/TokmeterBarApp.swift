// TokmeterBarApp.swift — App entry point.
//
// Uses SwiftUI's MenuBarExtra to put a small icon + cost indicator in the
// system menu bar. Clicking it opens the popover defined in TokmeterBarView.

import SwiftUI

@main
struct TokmeterBarApp: App {
    @StateObject private var loader = TokmeterLoader()
    @StateObject private var updater = UpdaterController()

    var body: some Scene {
        MenuBarExtra {
            TokmeterBarView(loader: loader, updater: updater)
        } label: {
            Label {
                Text(costLabel)
            } icon: {
                Image(systemName: "infinity")
            }
            .accessibilityLabel(accessibilityLabel)
        }
        .menuBarExtraStyle(.window)
    }

    /// Cost text shown next to the SF Symbol in the menu bar.
    /// Falls back to a question mark when the daemon is offline.
    private var costLabel: String {
        if loader.lastError != nil {
            return "?"
        }
        return String(format: "$%.2f", loader.todayCost)
    }

    /// VoiceOver-friendly description of the menu bar label.
    private var accessibilityLabel: String {
        if loader.lastError != nil {
            return "Tokmeter: daemon offline"
        }
        return String(format: "Tokmeter: today's cost is $%.2f", loader.todayCost)
    }
}
