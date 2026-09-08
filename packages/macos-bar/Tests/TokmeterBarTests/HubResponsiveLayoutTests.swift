import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

final class HubResponsiveLayoutTests: XCTestCase {
    @MainActor
    func testProductionHubAtMinimumAndWideWindowSizes() throws {
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { repository.deleteLastPathComponent() }
        let scenes = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf:
            repository.appendingPathComponent("docs/assets/demo/snapshots.json"))) as? [[String: Any]])
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = false
        loader.hasFreshData = true
        loader.totalTokens = 117_500_000_000
        loader.totalCost = 74_000
        loader.todayTokens = 232_700_000
        loader.todayCost = 240
        loader.stats = StatsData(totalCost: 74_000, totalTokens: 117_500_000_000,
                                 activeDays: 120, projects: 75, longestStreak: 20)
        loader.statbarSignals = try JSONDecoder().decode(StatbarSignals.self,
            from: JSONSerialization.data(withJSONObject: XCTUnwrap(scenes.last?["signals"])))
        loader.allDaily = [DailyUsage(date: "2026-09-01", tokens: 50_000_000, cost: 100),
                           DailyUsage(date: "2026-09-06", tokens: 200_000_000, cost: 220),
                           DailyUsage(date: "2026-09-08", tokens: 232_700_000, cost: 240)]
        loader.recentDaily = loader.allDaily
        for theme in [AppTheme.terminal, .glass, .nocturne, .aurora, .nebula] {
            let suite = "TokmeterHubResponsiveTests-\(UUID().uuidString)"
            let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
            preferences.set(theme.rawValue, forKey: "appTheme")
            defer { preferences.removePersistentDomain(forName: suite) }
            for width: CGFloat in [860, 1100, 1500] {
                let host = NSHostingView(rootView: HubView(loader: loader)
                    .defaultAppStorage(preferences)
                    .frame(width: width, height: 900))
                let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 900),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = host
                defer { window.contentView = nil }
                for _ in 0..<35 {
                    host.layoutSubtreeIfNeeded()
                    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
                }
                XCTAssertEqual(host.fittingSize.width, width, accuracy: 1)
                XCTAssertEqual(host.fittingSize.height, 900, accuracy: 1)
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                if theme == .glass {
                    // Dark ink needs the light material under the sidebar too.
                    let pixel = try XCTUnwrap(bitmap.colorAt(x: bitmap.pixelsWide / Int(width) * 100,
                        y: bitmap.pixelsHigh / 2)?.usingColorSpace(.sRGB))
                    XCTAssertGreaterThan(pixel.redComponent, 0.55)
                    XCTAssertGreaterThan(pixel.greenComponent, 0.55)
                    XCTAssertGreaterThan(pixel.blueComponent, 0.55)
                }
                if let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] {
                    try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                        .write(to: URL(fileURLWithPath: directory)
                            .appendingPathComponent("hub-responsive-\(theme.rawValue)-\(Int(width)).png"))
                }
            }
        }
    }

    @MainActor
    func testCostAndTokenTrendsHaveDifferentMeaning() {
        let cost = RecordedDayTrend(percent: 170.1, metric: .cost,
                                    previousDate: "2026-09-04", latestDate: "2026-09-06")
        let tokens = RecordedDayTrend(percent: 215.9, metric: .tokens,
                                      previousDate: "2026-09-04", latestDate: "2026-09-06")
        XCTAssertEqual(cost.color(theme: .terminal), AppTheme.terminal.statusWarning)
        XCTAssertEqual(tokens.color(theme: .terminal), AppTheme.terminal.backgroundMode.secondaryTextColor)
        XCTAssertTrue(cost.description.contains("Daily cost up 170.1%"))
        XCTAssertTrue(cost.description.contains("2026-09-06 vs 2026-09-04"))
        XCTAssertTrue(cost.description.contains("lifetime total"))
    }
}
