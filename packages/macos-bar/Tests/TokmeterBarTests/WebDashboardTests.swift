import Darwin
import XCTest
@testable import TokmeterBar

final class WebDashboardTests: XCTestCase {
    @MainActor
    func testControllerStartsReopensStopsAndRestartsActualDashboardChild() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let assets = root.appendingPathComponent("Dashboard")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        try Data("<html>native dashboard fixture</html>".utf8).write(to: assets.appendingPathComponent("index.html"))
        let packages = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
        try FileManager.default.copyItem(at: packages.appendingPathComponent("web/scripts/dashboard-server.mjs"),
                                        to: assets.appendingPathComponent("dashboard-server.mjs"))
        let directories = (ProcessInfo.processInfo.environment["PATH"] ?? "").split(separator: ":").map(String.init)
        let resolved = await NodeToolchain.firstSupported(
            candidates: NodeToolchain.candidates(systemDirectories: directories),
            environment: ProcessInfo.processInfo.environment)
        let toolchain = try XCTUnwrap(resolved)
        let port = try availablePort()
        var opened: [URL] = []
        let controller = WebDashboardController(resources: root, port: port,
                                               openURL: { opened.append($0) }, resolveToolchain: { toolchain })
        defer { controller.stop() }
        await controller.open()
        XCTAssertTrue(controller.isRunning, controller.error ?? "Not running")
        XCTAssertNil(controller.error)
        XCTAssertEqual(opened, [controller.url])
        let (body, response) = try await URLSession.shared.data(from: controller.url)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        XCTAssertTrue(String(decoding: body, as: UTF8.self).contains("native dashboard fixture"))
        await controller.open()
        XCTAssertEqual(opened.count, 2)

        // A second controller cannot open or stop the first controller's server.
        var foreignOpens = 0
        let contender = WebDashboardController(resources: root, port: port,
                                              openURL: { _ in foreignOpens += 1 }, resolveToolchain: { toolchain })
        await contender.open()
        XCTAssertFalse(contender.isRunning)
        XCTAssertNotNil(contender.error)
        XCTAssertEqual(foreignOpens, 0)
        XCTAssertTrue(controller.isRunning)
        contender.stop()

        controller.stop()
        XCTAssertFalse(controller.isRunning)
        // EOF/termination runs asynchronously in the owned child.
        var stopped = false
        for _ in 0..<30 {
            if (try? await URLSession.shared.data(from: controller.url)) == nil { stopped = true; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertTrue(stopped)
        await controller.open()
        XCTAssertTrue(controller.isRunning, controller.error ?? "Restart failed")
        XCTAssertEqual(opened.count, 3)
    }

    @MainActor
    func testCancelDuringRuntimeResolutionCannotLaunchOrPublishAnError() async throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        let assets = root.appendingPathComponent("Dashboard")
        try FileManager.default.createDirectory(at: assets, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        for name in ["index.html", "dashboard-server.mjs"] {
            try Data().write(to: assets.appendingPathComponent(name))
        }
        var resume: CheckedContinuation<NodeToolchain?, Never>?
        var opened = false
        let controller = WebDashboardController(resources: root, openURL: { _ in opened = true },
                                               resolveToolchain: { await withCheckedContinuation { resume = $0 } })
        let start = Task { await controller.open() }
        while resume == nil { await Task.yield() }
        XCTAssertTrue(controller.isStarting)
        controller.stop()
        resume?.resume(returning: nil)
        await start.value
        XCTAssertFalse(controller.isStarting)
        XCTAssertFalse(controller.isRunning)
        XCTAssertFalse(opened)
        XCTAssertNil(controller.error)
    }

    private func availablePort() throws -> Int {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        guard fd >= 0 else { throw POSIXError(.EIO) }
        defer { close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        guard bound == 0 else { throw POSIXError(.EADDRINUSE) }
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let result = withUnsafeMutablePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        guard result == 0 else { throw POSIXError(.EIO) }
        return Int(UInt16(bigEndian: address.sin_port))
    }
}
