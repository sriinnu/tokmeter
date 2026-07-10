// PanelVisibility.swift — tracks whether the popover's NSWindow is actually
// on screen right now.
//
// MenuBarExtra(.window) does NOT unmount its SwiftUI content when the
// popover closes — the window is merely ordered out, but the view hierarchy
// inside it (and every TimelineView/repeatForever animation driving it)
// stays alive and keeps ticking. Confirmed with `sample`: a freshly launched
// app that was never once clicked open still showed sustained 20-55% CPU
// from Auto Layout/Core Animation commit cycles, driven by the always-on ECG
// trace, footer heartbeat dot, and the hero's one-shot `repeatForever`
// breathing animations (which, once triggered, loop via Core Animation
// forever regardless of screen visibility — SwiftUI never auto-pauses them).
//
// This tracks real on-screen visibility via NSWindow.occlusionState so those
// views can stop animating when nobody can see them.

import AppKit
import SwiftUI

@MainActor
final class PanelVisibility: ObservableObject {
    @Published var isVisible: Bool = false

    private var observer: NSObjectProtocol?
    private weak var window: NSWindow?

    func attach(to window: NSWindow) {
        guard self.window !== window else { return }
        detach()
        self.window = window
        isVisible = window.occlusionState.contains(.visible)
        observer = NotificationCenter.default.addObserver(
            forName: NSWindow.didChangeOcclusionStateNotification,
            object: window,
            queue: .main
        ) { _ in
            // queue: .main above guarantees this runs on the main thread at
            // runtime, but the closure type itself isn't @MainActor —
            // Task { @MainActor in } bridges that for the isolated mutation.
            Task { @MainActor [weak self, weak window] in
                guard let self, let window else { return }
                self.isVisible = window.occlusionState.contains(.visible)
            }
        }
    }

    private func detach() {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        observer = nil
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
    }
}

/// Zero-size, non-drawing hook into AppKit's window graph — finds the
/// NSWindow hosting the SwiftUI view it's attached to and hands it to
/// `PanelVisibility`. `updateNSView` re-attaches on every SwiftUI update
/// too, since the very first `makeNSView` call can race the view actually
/// being inserted into a window.
private struct WindowAccessor: NSViewRepresentable {
    let visibility: PanelVisibility

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        DispatchQueue.main.async { [weak view] in
            if let window = view?.window {
                visibility.attach(to: window)
            }
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        if let window = nsView.window {
            visibility.attach(to: window)
        }
    }
}

extension View {
    /// Reports this view's hosting window's on-screen visibility into
    /// `visibility`. Attach once near the root of a scene's content.
    func trackPanelVisibility(_ visibility: PanelVisibility) -> some View {
        background(WindowAccessor(visibility: visibility))
    }
}
