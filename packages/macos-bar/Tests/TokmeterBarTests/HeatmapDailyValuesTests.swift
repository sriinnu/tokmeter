import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

final class HeatmapDailyValuesTests: XCTestCase {
    @MainActor
    func testDailyValuesDisclosureFitsNarrowHubAndOffersNativeRowNavigation() throws {
        for theme in [AppTheme.terminal, .glass] {
            let model = ExpansionModel()
            let host = NSHostingView(rootView: DailyValuesFixture(model: model, theme: theme))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 320),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.contentView = host
            defer { window.contentView = nil }

            func settle() -> CGFloat {
                for _ in 0..<10 {
                    host.layoutSubtreeIfNeeded()
                    window.setContentSize(host.fittingSize)
                    RunLoop.main.run(until: Date().addingTimeInterval(0.02))
                }
                return host.fittingSize.height
            }
            let collapsedHeight = settle()
            XCTAssertNil(findTable(in: host))
            model.expanded = true
            let expandedHeight = settle()
            XCTAssertGreaterThan(expandedHeight, collapsedHeight + 80)
            XCTAssertLessThan(expandedHeight, 350)
            XCTAssertEqual(host.fittingSize.width, 480, accuracy: 1)

            let table = try XCTUnwrap(findTable(in: host))
            XCTAssertEqual(table.numberOfRows, 3)
            XCTAssertEqual(table.numberOfColumns, 3)
            XCTAssertTrue(table.acceptsFirstResponder)
            table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
            let down = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero,
                modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber,
                context: nil, characters: "\u{F701}", charactersIgnoringModifiers: "\u{F701}",
                isARepeat: false, keyCode: 125))
            table.keyDown(with: down)
            XCTAssertEqual(table.selectedRow, 1)

            if let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] {
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: URL(fileURLWithPath: directory)
                        .appendingPathComponent("heatmap-daily-values-\(theme.rawValue).png"))
            }
            model.expanded = false
            XCTAssertEqual(settle(), collapsedHeight, accuracy: 1)
        }
    }

    @MainActor
    private func findTable(in view: NSView) -> NSTableView? {
        if let table = view as? NSTableView { return table }
        return view.subviews.lazy.compactMap { self.findTable(in: $0) }.first
    }
}

private final class ExpansionModel: ObservableObject {
    @Published var expanded = false
}

private struct DailyValuesFixture: View {
    @ObservedObject var model: ExpansionModel
    let theme: AppTheme
    private let daily = [
        DailyUsage(date: "2026-09-08", tokens: 232_700_000, cost: 240),
        DailyUsage(date: "2026-09-06", tokens: 1_234_567_890, cost: 12_345.67),
        DailyUsage(date: "2026-09-01", tokens: 100, cost: 0),
    ]

    var body: some View {
        HeatmapDailyValues(daily: daily, theme: theme, isExpanded: $model.expanded)
            .padding(12)
            .frame(width: 480)
            .fixedSize(horizontal: false, vertical: true)
            .background(theme.backgroundMode.surfaceColor)
            .environment(\.colorScheme, theme.backgroundMode.isLight ? .light : .dark)
    }
}
