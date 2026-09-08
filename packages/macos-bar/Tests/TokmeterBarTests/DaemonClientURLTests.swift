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

    func testPlainReadAndMutationRoutesKeepTheirPaths() {
        for path in ["/api/quick", "/api/sessions", "/api/update-pricing", "/api/rescan"] {
            XCTAssertEqual(DaemonClient.requestURL(for: path).absoluteString,
                           "http://127.0.0.1:9877" + path)
        }
    }
}
