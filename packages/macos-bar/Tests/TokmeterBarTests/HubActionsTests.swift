import XCTest
@testable import TokmeterBar

final class HubActionsTests: XCTestCase {
    @MainActor
    func testCopiedProjectCommandsPreserveLiteralShellArguments() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let marker = root.appendingPathComponent("must-not-exist")
        let project = "Sriinnu's project $(touch \(marker.path)) `echo wrong`\nsecond line"
        let expected = [
            ["cleanup", "--project", project, "--dry-run"],
            ["snapshot", "--project", project],
            ["alias", "set", project, "Better Name"],
            ["alias", "hide", project],
        ]
        for (command, arguments) in zip(HubProjectCliActions.commands(for: project), expected) {
            // A shell function captures argv; no real tokmeter command or data is touched.
            let script = "tokmeter() { printf '%s\\0' \"$@\"; }; " + command.command
            let output = try await SubprocessRunner.run(executable: "/bin/sh", arguments: ["-c", script],
                                                       environment: ["PATH": "/usr/bin:/bin"], timeout: 3)
            let actual = output.split(separator: "\0", omittingEmptySubsequences: false).dropLast().map(String.init)
            XCTAssertEqual(actual, arguments)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path))
    }

    @MainActor
    func testSettingsPersistBeforePublishingAndRecoverFromWriteFailure() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let directory = root.appendingPathComponent("settings")
        let path = directory.appendingPathComponent("config.json").path
        defer { try? FileManager.default.removeItem(at: root) }
        let store = HubConfigStore(filePath: path)
        store.update { $0.bar.refreshSeconds = 45 }
        XCTAssertNil(store.saveError)
        XCTAssertEqual(HubConfigStore(filePath: path).config.bar.refreshSeconds, 45)
        store.update { $0.bar.refreshSeconds = 60 }
        XCTAssertEqual(HubConfigStore(filePath: path).config.bar.refreshSeconds, 60)

        try FileManager.default.removeItem(at: directory)
        try Data("blocked parent".utf8).write(to: directory)
        store.reset()
        XCTAssertNotNil(store.saveError)
        XCTAssertEqual(store.config.bar.refreshSeconds, 60)
        store.update { $0.bar.refreshSeconds = 90 }
        XCTAssertEqual(store.config.bar.refreshSeconds, 60)

        try FileManager.default.removeItem(at: directory)
        store.update { $0.bar.refreshSeconds = 90 }
        XCTAssertNil(store.saveError)
        XCTAssertEqual(HubConfigStore(filePath: path).config.bar.refreshSeconds, 90)
    }

    func testDaemonAndIntegrationCatalogUsesDrishtiEntrypoint() {
        let groups = HubCommandCatalog.groups.filter { ["daemon", "install"].contains($0.id) }
        XCTAssertFalse(groups.isEmpty)
        for command in groups.flatMap(\.commands) {
            XCTAssertTrue(command.example.hasPrefix("drishti "), command.id)
        }
    }
}
