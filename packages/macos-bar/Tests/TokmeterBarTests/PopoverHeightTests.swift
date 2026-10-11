import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

/// The popover is dynamic-height: it hugs its content up to a cap, then
/// scrolls. A day with many models used to grow the window past the cap on
/// the first layout (before the content was measured), and the MenuBarExtra
/// window then kept that height, leaving empty bands above and below.
final class PopoverHeightTests: XCTestCase {
    @MainActor
    func testEveryThemeStaysWithinCapAndShrinksBack() throws {
        for theme in AppTheme.allCases {
            let loader = TokmeterLoader(startPolling: false)
            loader.isWarming = false
            loader.hasFreshData = true
            loader.isDaemonAlive = true
            loader.todayTokens = 247_300_000
            let preferences = try XCTUnwrap(UserDefaults(suiteName: "TokmeterPopoverHeightTests"))
            let host = NSHostingView(rootView:
                TokmeterBarView(loader: loader, updater: UpdaterController(startingUpdater: false),
                                theme: theme, usageDetailsExpanded: true)
                    .defaultAppStorage(preferences))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 1),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            func settle() -> CGFloat {
                for _ in 0..<12 {
                    host.layoutSubtreeIfNeeded()
                    window.setContentSize(host.fittingSize)
                    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
                }
                return host.fittingSize.height
            }
            let small = settle()
            // A heavy day: many models and projects, all at once (first layout).
            loader.todayModels = (1...14).map {
                ModelUsage(model: "model-\($0)", provider: "codex", cost: Double(20 - $0),
                           tokens: 1_000_000, inputTokens: 400_000, outputTokens: 100_000,
                           cacheReadTokens: 500_000, cacheWriteTokens: 0, reasoningTokens: 0)
            }
            loader.topModels = loader.todayModels
            loader.todayProjects = (1...12).map {
                ProjectData(project: "project-\($0)", totalCost: Double($0), totalTokens: 1_000_000,
                            activeDays: 1, lastUsed: nil)
            }
            host.layoutSubtreeIfNeeded()
            let firstPass = host.fittingSize.height
            let big = settle()
            let cap = min(780, (NSScreen.main?.visibleFrame.height ?? 900) - 32)
            XCTAssertLessThanOrEqual(firstPass, cap + 1, "\(theme): first layout overshoots the cap")
            XCTAssertLessThanOrEqual(big, cap + 1, "\(theme): settled height exceeds the cap")
            if let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] {
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: URL(fileURLWithPath: directory).appendingPathComponent("window-\(theme.rawValue).png"))
            }
            loader.todayModels = []
            loader.topModels = []
            loader.todayProjects = []
            XCTAssertEqual(settle(), small, accuracy: 1, "\(theme): popover didn't shrink back")
            window.contentView = nil
        }
    }
}
