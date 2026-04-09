// UpdaterController.swift — Sparkle integration.
//
// Wraps Sparkle's SPUStandardUpdaterController so the SwiftUI app can:
//   - Check for updates automatically on launch + every 24h
//   - Surface a "Check for Updates…" menu item that the user can trigger
//   - Display a "new version available" dialog with release notes
//
// Sparkle reads its config from Info.plist:
//   SUFeedURL    — URL to the appcast.xml on your release server
//   SUPublicEDKey — public half of the EdDSA keypair (private half signs releases)
//   SUEnableInstallerLauncherService = true  (modern installer flow)
//
// The bundle.sh script writes those keys for you. See RELEASE.md.

import Combine
import Foundation
import Sparkle
import SwiftUI

@MainActor
final class UpdaterController: ObservableObject {
    /// The actual Sparkle controller. Held strong so its lifecycle matches the app.
    let updater: SPUStandardUpdaterController

    /// Published so the SwiftUI button can disable while a check is in flight.
    /// Initialised true (the natural state) and updated from Sparkle's KVO
    /// publisher — without a true initial value the button flickers disabled
    /// for a frame when the popover first opens.
    @Published var canCheckForUpdates: Bool = true

    init() {
        // startingUpdater: true means Sparkle starts polling immediately.
        // updaterDelegate: nil — we accept all of Sparkle's defaults.
        // userDriverDelegate: nil — we use the default UI for prompts.
        self.updater = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        // Seed the published property from Sparkle's actual current state,
        // then keep it in sync via the KVO publisher.
        self.canCheckForUpdates = self.updater.updater.canCheckForUpdates
        self.updater.updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .assign(to: &$canCheckForUpdates)
    }

    /// Trigger a manual update check from a SwiftUI button.
    func checkForUpdates() {
        updater.checkForUpdates(nil)
    }
}
