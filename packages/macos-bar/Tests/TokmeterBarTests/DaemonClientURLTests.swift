import XCTest
@testable import TokmeterBar

final class DaemonClientURLTests: XCTestCase {
    func testTodaySessionsQueryIsSeparateFromRoute() throws {
        let url = DaemonClient.requestURL(for: "/api/sessions?today=true")
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/api/sessions")
        XCTAssertEqual(components.queryItems, [URLQueryItem(name: "today", value: "true")])
        XCTAssertEqual(url.absoluteString, "http://127.0.0.1:9877/api/sessions?today=true")
    }

    func testProjectNamesSurviveExactlyOneServerDecode() throws {
        // The daemon slices /api/projects/ and decodeURIComponent()s once.
        for name in ["tokmeter", "my project", "parent/child", "literal%2Fname", "name?#", "తెలుగు"] {
            let url = DaemonClient.requestURL(for: DaemonClient.projectDetailPath(name))
            let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
            let prefix = "/api/projects/"
            XCTAssertTrue(components.percentEncodedPath.hasPrefix(prefix), name)
            let encodedName = String(components.percentEncodedPath.dropFirst(prefix.count))
            XCTAssertFalse(encodedName.contains("/"), name)
            XCTAssertEqual(encodedName.removingPercentEncoding, name)
            XCTAssertNil(components.query, name)
            XCTAssertNil(components.fragment, name)
            XCTAssertEqual(components.host, "127.0.0.1")
            XCTAssertEqual(components.port, 9877)
        }
    }

    // The daemon sends both X-Tokmeter-API and the legacy X-Drishti-API; a
    // daemon from before the rename sends only the legacy one.
    private func response(_ headers: [String: String]) -> HTTPURLResponse {
        HTTPURLResponse(url: URL(string: "http://127.0.0.1:9877/api/quick")!, statusCode: 200,
                        httpVersion: "HTTP/1.1", headerFields: headers)!
    }

    func testApiVersionHeaderPrefersTheCurrentName() {
        let both = response(["X-Tokmeter-API": "tokmeter-api/1", "X-Drishti-API": "drishti-api/9"])
        XCTAssertEqual(DaemonClient.apiVersionHeader(from: both), "tokmeter-api/1")
    }

    func testApiVersionHeaderFallsBackToTheLegacyName() {
        let legacy = response(["X-Drishti-API": "drishti-api/1"])
        XCTAssertEqual(DaemonClient.apiVersionHeader(from: legacy), "drishti-api/1")
        XCTAssertNil(DaemonClient.apiVersionHeader(from: response([:])))
    }

    func testApiMajorReadsEitherSpelling() {
        XCTAssertEqual(DaemonClient.apiMajor(fromHeader: "tokmeter-api/1"), 1)
        XCTAssertEqual(DaemonClient.apiMajor(fromHeader: "drishti-api/2"), 2)
        XCTAssertNil(DaemonClient.apiMajor(fromHeader: "garbage"))
    }

    func testPlainReadAndMutationRoutesKeepTheirPaths() {
        for path in ["/api/quick", "/api/sessions", "/api/update-pricing", "/api/rescan"] {
            XCTAssertEqual(DaemonClient.requestURL(for: path).absoluteString,
                           "http://127.0.0.1:9877" + path)
        }
    }

    func testOwnedSmallFileReaderRejectsSymlinksAndOversizedFiles() throws {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("tokmeter-safe-read-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: dir) }

        let regular = dir.appendingPathComponent("pid")
        try Data("123\n".utf8).write(to: regular)
        XCTAssertEqual(DaemonClient.readOwnedSmallFile(regular.path, maxBytes: 32)?.text, "123\n")

        let link = dir.appendingPathComponent("pid-link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: regular)
        XCTAssertNil(DaemonClient.readOwnedSmallFile(link.path, maxBytes: 32))

        let oversized = dir.appendingPathComponent("oversized")
        try Data(repeating: 65, count: 33).write(to: oversized)
        XCTAssertNil(DaemonClient.readOwnedSmallFile(oversized.path, maxBytes: 32))
    }
}
