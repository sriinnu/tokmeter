import XCTest

@testable import TokmeterBar

/// config.json is owned by the CLI and its schema grows ahead of the Swift
/// struct. A Hub save must keep every key Swift doesn't model — before this,
/// changing any bar setting silently deleted `customSources` (1.14.0) and
/// dropped that usage out of every total.
final class HubConfigRoundTripTests: XCTestCase {
    private let cliWrittenJSON = """
        {
          "version": 1,
          "bar": { "refreshSeconds": 30, "futureBarKnob": "keep-me" },
          "daemon": { "scanIntervalSeconds": 60 },
          "cli": { "defaultRange": "all", "defaultSort": "cost" },
          "alerts": { "dailyCostThreshold": 25 },
          "customSources": [
            { "id": "muse-work", "label": "Muse (work)", "provider": "muse", "path": "/tmp/muse" }
          ],
          "modifiedBy": "tokmeter",
          "modifiedAt": "2026-10-01T00:00:00Z"
        }
        """

    @MainActor
    func testHubSavePreservesKeysSwiftDoesNotModel() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("config.json")
        try Data(cliWrittenJSON.utf8).write(to: url)

        let store = HubConfigStore(filePath: url.path)
        store.update { $0.bar.weekChartStyle = .bars }
        XCTAssertNil(store.saveError)

        let raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let sources = try XCTUnwrap(raw["customSources"] as? [[String: Any]])
        XCTAssertEqual(sources.first?["id"] as? String, "muse-work")
        let bar = try XCTUnwrap(raw["bar"] as? [String: Any])
        XCTAssertEqual(bar["futureBarKnob"] as? String, "keep-me")
        XCTAssertEqual(bar["weekChartStyle"] as? String, "bars")
        XCTAssertEqual(raw["modifiedBy"] as? String, "user")
    }

    /// Clearing a modeled optional must actually clear it — the merge must not
    /// read the encoder's omitted nil as "unknown key, keep the disk value".
    @MainActor
    func testClearingBudgetDoesNotResurrectDiskValue() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let url = root.appendingPathComponent("config.json")
        try Data(cliWrittenJSON.utf8).write(to: url)

        let store = HubConfigStore(filePath: url.path)
        XCTAssertEqual(store.config.alerts.dailyCostThreshold, 25)
        store.update { $0.alerts.dailyCostThreshold = nil }

        XCTAssertNil(HubConfigStore(filePath: url.path).config.alerts.dailyCostThreshold)
        let raw = try XCTUnwrap(
            JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        XCTAssertNotNil(raw["customSources"])
    }
}
