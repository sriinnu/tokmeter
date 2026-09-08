import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

final class PopoverLayoutTests: XCTestCase {
    @MainActor
    func testFullPopoverHasUsageContentOnFirstLayout() throws {
        for theme in [AppTheme.nebula, .glass, .terminal, .paper, .nocturne, .aurora] {
            for expanded in [false, true] {
                try checkFullPopover(expanded: expanded, theme: theme)
            }
        }
    }

    @MainActor
    private func checkFullPopover(expanded: Bool, theme: AppTheme) throws {
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = false
        loader.pricingMtime = Date().timeIntervalSince1970 * 1000
        loader.healthStatus = HealthStatus(unpricedModels: ["sample-missing-a", "sample-missing-b"], unpricedRecords: 2)
        loader.pricingAnomalies = AnomaliesResponse(anomalies: (1...5).map {
            PricingAnomaly(ts: 0, key: "sample-model-\($0)", field: "input", side: "increase",
                           previous: 1, current: 2, deltaPct: 100)
        }, total: 5, cappedAt: 100)
        let preferences = try XCTUnwrap(UserDefaults(suiteName: "TokmeterPopoverLayoutTests"))
        let host = NSHostingView(rootView:
            TokmeterBarView(loader: loader, updater: UpdaterController(startingUpdater: false),
                            theme: theme, usageDetailsExpanded: expanded)
                .defaultAppStorage(preferences)
                .environment(\.colorScheme, .dark))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 1),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.appearance = NSAppearance(named: .darkAqua)
        window.contentView = host
        func settle() -> CGFloat {
            for _ in 0..<10 {
                host.layoutSubtreeIfNeeded()
                window.setContentSize(host.fittingSize)
                RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            }
            return host.fittingSize.height
        }
        // Even with no usage records, the explanation and disclosure must fit
        // between the actual production hero and footer on the first opening.
        let emptyHeight = settle()
        XCTAssertGreaterThan(emptyHeight, 200)
        XCTAssertLessThan(emptyHeight, 450)
        loader.todayModels = [ModelUsage(model: "sample-model", provider: "codex", cost: 1,
                                        tokens: 100, inputTokens: 80, outputTokens: 20,
                                        cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0)]
        loader.topModels = loader.todayModels
        loader.todayProjects = [ProjectData(project: "sample-project", totalCost: 1,
                                           totalTokens: 100, activeDays: 1, lastUsed: nil)]
        let populatedHeight = settle()
        XCTAssertGreaterThan(populatedHeight, emptyHeight + 100)
        if let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] {
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: directory)
                    .appendingPathComponent("full-\(theme.rawValue)-popover-\(expanded ? "expanded" : "collapsed").png"))
        }
        loader.todayModels = []
        loader.topModels = []
        loader.todayProjects = []
        XCTAssertEqual(settle(), emptyHeight, accuracy: 1)
        window.contentView = nil
    }

    @MainActor
    func testUsageDisclosureResizesAndAdaptsToAvailableHeight() {
        let model = DisclosureModel()
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = false
        let host = NSHostingView(rootView: DisclosureFixture(model: model, loader: loader))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 1),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        func settle() -> CGFloat {
            for _ in 0..<10 {
                host.layoutSubtreeIfNeeded()
                window.setContentSize(host.fittingSize)
                RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            }
            return host.fittingSize.height
        }
        let collapsed = settle()
        XCTAssertGreaterThan(collapsed, 30)
        model.expanded = true
        let expanded = settle()
        XCTAssertGreaterThan(expanded, collapsed + 80)
        model.maximumHeight = 100
        XCTAssertEqual(settle(), 100, accuracy: 1)
        model.maximumHeight = 600
        XCTAssertEqual(settle(), expanded, accuracy: 1)
        model.expanded = false
        XCTAssertEqual(settle(), collapsed, accuracy: 1)
        window.contentView = nil
    }

    @MainActor
    func testScrollAreaGrowsCapsAndShrinksWithContent() {
        let model = HeightModel()
        let host = NSHostingView(rootView: LayoutFixture(model: model))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 600),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.contentView = host
        func measuredHeight() -> CGFloat {
            // Geometry preferences commit on the next layout/run-loop turn.
            for _ in 0..<5 {
                host.layoutSubtreeIfNeeded()
                RunLoop.main.run(until: Date().addingTimeInterval(0.02))
            }
            return host.fittingSize.height
        }
        XCTAssertEqual(measuredHeight(), 160, accuracy: 1)
        model.height = 900
        XCTAssertEqual(measuredHeight(), 360, accuracy: 1)
        model.height = 100
        XCTAssertEqual(measuredHeight(), 160, accuracy: 1)
        window.contentView = nil
    }
}

private final class DisclosureModel: ObservableObject {
    @Published var expanded = false
    @Published var maximumHeight: CGFloat = 600
}

private struct DisclosureFixture: View {
    @ObservedObject var model: DisclosureModel
    @ObservedObject var loader: TokmeterLoader
    var body: some View {
        ContentSizedScrollView(maximumHeight: model.maximumHeight) {
            UsageOverview(loader: loader, theme: .terminal, showUsageDetails: $model.expanded)
                .padding(16)
        }
        .frame(width: 400)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private final class HeightModel: ObservableObject {
    @Published var height: CGFloat = 100
}

private struct LayoutFixture: View {
    @ObservedObject var model: HeightModel
    var body: some View {
        VStack(spacing: 0) {
            Color.clear.frame(height: 40)
            ContentSizedScrollView(maximumHeight: 300) {
                Color.blue.frame(height: model.height)
            }
            Color.clear.frame(height: 20)
        }
        .frame(width: 400)
        .fixedSize(horizontal: false, vertical: true)
    }
}
