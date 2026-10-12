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
    @Published var screenHeight: CGFloat = NSScreen.main?.visibleFrame.height ?? 812

    /// The panel's own measured height. The window is sized to this, never
    /// the other way round; see `fitWindow`.
    private var contentHeight: CGFloat = 0
    /// Where the window's top edge belongs: under the menu bar, as placed
    /// when the panel opens. Kept fixed whoever resizes the window.
    private var topEdge: CGFloat?
    /// Tests host the panel in an offscreen window, which never reports
    /// `.visible`; this lets them exercise the open path.
    static var treatOffscreenAsVisibleForTests = false

    private var observer: NSObjectProtocol?
    private var screenObservers: [NSObjectProtocol] = []
    private weak var window: NSWindow?

    func attach(to window: NSWindow) {
        guard self.window !== window else { return }
        detach()
        self.window = window
        topEdge = window.frame.maxY
        fitWindow()
        isVisible = window.occlusionState.contains(.visible)
        screenHeight = window.screen?.visibleFrame.height ?? screenHeight
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
                    || Self.treatOffscreenAsVisibleForTests
                self.screenHeight = window.screen?.visibleFrame.height ?? self.screenHeight
                // Opening: the system has just hung the window under the menu
                // bar, so this is the top edge to keep. (Attach can land after
                // AppKit's first resize, so its reading isn't trusted.) Then
                // drop any height left over from last time.
                if self.isVisible {
                    self.topEdge = window.frame.maxY
                    self.fitWindow()
                }
            }
        }
        // NSHostingView also resizes the window to its content, keeping the
        // bottom edge, which drops the top away from the menu bar. Whichever
        // resize lands last, put the top edge and the height back.
        screenObservers.append(NotificationCenter.default.addObserver(
            forName: NSWindow.didResizeNotification, object: window, queue: .main
        ) { _ in
            Task { @MainActor [weak self] in self?.fitWindow() }
        })
        for name in [NSWindow.didChangeScreenNotification, NSApplication.didChangeScreenParametersNotification] {
            screenObservers.append(NotificationCenter.default.addObserver(
                forName: name, object: name == NSWindow.didChangeScreenNotification ? window : nil, queue: .main
            ) { _ in
                Task { @MainActor [weak self, weak window] in
                    guard let self, let window else { return }
                    self.screenHeight = window.screen?.visibleFrame.height ?? self.screenHeight
                }
            })
        }
    }

    /// Records the panel's measured height and sizes the window to it.
    func contentHeightChanged(_ height: CGFloat) {
        contentHeight = height
        fitWindow()
    }

    /// MenuBarExtra(.window) grows its window when the content grows but
    /// never shrinks it, and SwiftUI centres the smaller panel in the leftover
    /// space: empty bands above and below. So the window is sized here, to the
    /// panel's own height, keeping the top edge under the menu bar fixed.
    func fitWindow() {
        guard let window, contentHeight > 0 else { return }
        let content = window.contentRect(forFrameRect: window.frame)
        let target = window.frameRect(forContentRect: NSRect(x: content.minX, y: content.minY,
                                                             width: content.width, height: contentHeight))
        let top = topEdge ?? window.frame.maxY
        var frame = window.frame
        guard abs(frame.height - target.height) > 0.5 || abs(frame.maxY - top) > 0.5 else { return }
        frame.size.height = target.height
        frame.origin.y = top - target.height
        window.setFrame(frame, display: true, animate: false)
    }

    private func detach() {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        observer = nil
        screenObservers.forEach(NotificationCenter.default.removeObserver)
        screenObservers = []
    }

    deinit {
        if let observer {
            NotificationCenter.default.removeObserver(observer)
        }
        screenObservers.forEach(NotificationCenter.default.removeObserver)
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
