// TokmeterBarApp.swift — App entry point.
//
// Uses SwiftUI's MenuBarExtra to put a small icon + cost indicator in the
// system menu bar. Clicking it opens the popover defined in TokmeterBarView.

import SwiftUI

@main
struct TokmeterBarApp: App {
    @StateObject private var loader = TokmeterLoader()

    var body: some Scene {
        MenuBarExtra {
            TokmeterBarView(loader: loader)
        } label: {
            Text(menuBarLabel)
        }
        .menuBarExtraStyle(.window)
    }

    /// Menu bar label — shows today's cost with the infinity glyph.
    /// Falls back to a question mark when the daemon is offline.
    private var menuBarLabel: String {
        if loader.lastError != nil {
            return "♾️ ?"
        }
        return String(format: "♾️ $%.2f", loader.todayCost)
    }
}
