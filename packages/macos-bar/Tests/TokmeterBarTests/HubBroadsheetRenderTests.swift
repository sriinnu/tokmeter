import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

/// Opt-in render of every Hub section in every theme, for visual QA and
/// byte-identical before/after checks. Set TOKMETER_HUB_QA_DIR to run.
final class HubBroadsheetRenderTests: XCTestCase {
    @MainActor
    func testRenderHubSections() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_HUB_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_HUB_QA_DIR for hub inspection")
        }
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { repository.deleteLastPathComponent() }
        let scenes = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf:
            repository.appendingPathComponent("docs/assets/demo/snapshots.json"))) as? [[String: Any]])
        let root = URL(fileURLWithPath: directory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = false
        loader.hasFreshData = true
        loader.isDaemonAlive = true
        loader.totalTokens = 143_800_000_000
        loader.totalCost = 85_000
        loader.todayTokens = 34_400_000
        loader.todayCost = 10.23
        loader.stats = StatsData(totalCost: 85_000, totalTokens: 143_800_000_000,
                                 activeDays: 284, projects: 95, longestStreak: 41)
        loader.statbarSignals = try JSONDecoder().decode(StatbarSignals.self,
            from: JSONSerialization.data(withJSONObject: XCTUnwrap(scenes.last?["signals"])))
        let models = try JSONDecoder().decode([ModelData].self,
            from: JSONSerialization.data(withJSONObject: XCTUnwrap(scenes.last?["models"])))
        loader.todayModels = models.map(TokmeterLoader.toUsage)
        loader.topModels = loader.todayModels
        loader.todayProjects = try JSONDecoder().decode([ProjectData].self,
            from: JSONSerialization.data(withJSONObject: XCTUnwrap(scenes.last?["projects"])))
        // Baseline mode leaves the project list empty, for before/after diffs.
        if ProcessInfo.processInfo.environment["TOKMETER_HUB_QA_EMPTY_PROJECTS"] == nil {
            loader.sessions = loader.todayProjects
        }
        loader.allDaily = (1...30).map { day in
            DailyUsage(date: String(format: "2026-09-%02d", day),
                       tokens: 40_000_000 + (day * 7_919 % 13) * 9_000_000,
                       cost: 60 + Double(day * 31 % 17) * 9)
        }
        loader.recentDaily = Array(loader.allDaily.suffix(7))
        // TOKMETER_HUB_QA_THEMES=meter,pump narrows the run; sections likewise.
        let onlyThemes = ProcessInfo.processInfo.environment["TOKMETER_HUB_QA_THEMES"]?
            .split(separator: ",").map(String.init)
        let onlySections = ProcessInfo.processInfo.environment["TOKMETER_HUB_QA_SECTIONS"]?
            .split(separator: ",").map(String.init)
        for theme in AppTheme.allCases where onlyThemes?.contains(theme.rawValue) ?? true {
            for section in HubSection.allCases where onlySections?.contains(section.rawValue) ?? true {
                let suite = "TokmeterHubRender-\(UUID().uuidString)"
                let preferences = try XCTUnwrap(UserDefaults(suiteName: suite))
                preferences.set(theme.rawValue, forKey: "appTheme")
                defer { preferences.removePersistentDomain(forName: suite) }
                let size = NSSize(width: 1100, height: 900)
                let host = NSHostingView(rootView: HubView(loader: loader, initialSelection: section)
                    .defaultAppStorage(preferences)
                    .transaction { $0.disablesAnimations = true }
                    .frame(width: size.width, height: size.height))
                let window = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                                      styleMask: [.borderless], backing: .buffered, defer: false)
                window.contentView = host
                defer { window.contentView = nil }
                for _ in 0..<40 {
                    host.layoutSubtreeIfNeeded()
                    RunLoop.main.run(until: Date().addingTimeInterval(0.03))
                }
                let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
                host.cacheDisplay(in: host.bounds, to: bitmap)
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: root.appendingPathComponent("hub-\(theme.rawValue)-\(section.rawValue).png"))
            }
        }
    }
}
