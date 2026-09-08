import XCTest
@testable import TokmeterBar

final class StartupTests: XCTestCase {
    func testDaemonBootstrapUsesPackageThatActuallyContainsDaemon() {
        XCTAssertEqual(NodeToolchain.daemonArguments(version: "1.10.0"),
                       ["--yes", "@sriinnu/drishti@1.10.0", "daemon", "start"])
    }

    func testNpxWithoutPairedNodeIsNotAnInstallation() {
        let files: Set<String> = ["/broken/npx", "/working/npx", "/working/node"]
        XCTAssertEqual(NodeToolchain.firstAvailable(directories: ["/broken", "/working"],
                                                    isExecutable: files.contains)?.binDirectory, "/working")
    }

    func testManagedNodeIsFoundWithoutShellPathOrDotfiles() throws {
        let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: root) }
        for version in ["v16.20.0", "v22.9.0", "v22.10.0"] {
            let bin = root.appendingPathComponent(".nvm/versions/node/\(version)/bin")
            try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
            for name in ["node", "npx"] {
                let file = bin.appendingPathComponent(name)
                try Data().write(to: file)
                try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: file.path)
            }
        }
        let toolchain = NodeToolchain.resolve(home: root.path, systemDirectories: [])
        XCTAssertEqual(toolchain?.binDirectory, root.path + "/.nvm/versions/node/v22.10.0/bin")
        let environment = try XCTUnwrap(toolchain).environment(base: ["PATH": "/usr/bin:/bin", "LANG": "en_US.UTF-8"])
        XCTAssertEqual(environment["PATH"]?.split(separator: ":").first.map(String.init), toolchain?.binDirectory)
        XCTAssertEqual(environment["LANG"], "en_US.UTF-8")
    }

    func testMissingNodeIsRepresentableWithoutAttemptingAnInstall() {
        XCTAssertNil(NodeToolchain.firstAvailable(directories: ["/missing"], isExecutable: { _ in false }))
        XCTAssertEqual(NodeToolchain.majorVersion("v22.0.0\n"), 22)
        XCTAssertNil(NodeToolchain.majorVersion("not node"))
    }

    @MainActor
    func testProtocolFailureStopsWarmingAndClearsLiveClaims() {
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = true
        loader.hasFreshData = true
        loader.liveContextFillPct = 90
        loader.blockPct = 50
        loader.recordConnectionFailure(DaemonError.versionMismatch(2))
        XCTAssertFalse(loader.isWarming)
        XCTAssertFalse(loader.hasFreshData)
        XCTAssertFalse(loader.isStartingDaemon)
        XCTAssertNil(loader.liveContextFillPct)
        XCTAssertNil(loader.blockPct)
        XCTAssertTrue(loader.lastError?.contains("incompatible") == true)
    }
}

final class SubprocessRunnerTests: XCTestCase {
    private let environment = ["PATH": "/usr/bin:/bin"]

    func testDrainsNoisyStdoutAndStderrWithoutPipeDeadlock() async throws {
        let output = try await SubprocessRunner.run(
            executable: "/usr/bin/python3",
            arguments: ["-c", "import sys; sys.stdout.write('x'*524288); sys.stdout.flush(); sys.stderr.write('e'*524288)"],
            environment: environment, timeout: 10)
        XCTAssertEqual(output.count, 262_144)
        XCTAssertTrue(output.allSatisfy { $0 == "x" })
    }

    func testNonzeroExitIncludesBoundedFailureReason() async {
        do {
            _ = try await SubprocessRunner.run(executable: "/bin/sh", arguments: ["-c", "echo install-failed >&2; exit 9"],
                                               environment: environment, timeout: 5)
            XCTFail("Expected nonzero exit")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("exit 9: install-failed"))
        }
    }

    func testTimeoutReturnsWithoutWaitingForChild() async {
        let start = Date()
        do {
            _ = try await SubprocessRunner.run(executable: "/bin/sleep", arguments: ["10"],
                                               environment: environment, timeout: 0.1)
            XCTFail("Expected timeout")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("timed out"))
            XCTAssertLessThan(Date().timeIntervalSince(start), 3)
        }
    }

    func testMissingExecutableFailsPromptly() async {
        do {
            _ = try await SubprocessRunner.run(executable: "/does/not/exist", arguments: [],
                                               environment: environment, timeout: 5)
            XCTFail("Expected launch failure")
        } catch { }
    }
}
