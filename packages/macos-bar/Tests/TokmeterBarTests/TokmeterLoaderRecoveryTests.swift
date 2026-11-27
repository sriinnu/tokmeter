import Foundation
import XCTest
@testable import TokmeterBar

private final class SequenceURLProtocol: URLProtocol {
    static var handler: ((URLRequest, Int) -> (Int, Data?, Error?))?
    private static var attempt = 0
    private static let lock = NSLock()

    static func reset() {
        lock.lock()
        attempt = 0
        lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock()
        Self.attempt += 1
        let current = Self.attempt
        Self.lock.unlock()

        guard let (status, data, error) = Self.handler?(request, current) else {
            client?.urlProtocol(self, didFailWithError: URLError(.unknown))
            return
        }
        if let error {
            client?.urlProtocol(self, didFailWithError: error)
            return
        }
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: status,
            httpVersion: "HTTP/1.1",
            headerFields: ["X-Tokmeter-API": "tokmeter-api/1"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        if let data {
            client?.urlProtocol(self, didLoad: data)
        }
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class TokmeterLoaderRecoveryTests: XCTestCase {
    @MainActor
    func testRecoveryDelayUsesShortExponentialBackoffEvenWhenRefreshSecondsIsLarge() {
        XCTAssertEqual(TokmeterLoader.recoveryDelay(attempt: 1, refreshSeconds: 300), 2)
        XCTAssertEqual(TokmeterLoader.recoveryDelay(attempt: 2, refreshSeconds: 300), 4)
        XCTAssertEqual(TokmeterLoader.recoveryDelay(attempt: 3, refreshSeconds: 300), 8)
        XCTAssertEqual(TokmeterLoader.recoveryDelay(attempt: 4, refreshSeconds: 300), 16)
        XCTAssertEqual(TokmeterLoader.recoveryDelay(attempt: 5, refreshSeconds: 300), 30)
        XCTAssertEqual(TokmeterLoader.recoveryDelay(attempt: 5, refreshSeconds: 10), 10)
    }

    @MainActor
    func testShouldReloadOnPopoverOpenDetectsWarmingOfflineStaleAndDayRollover() {
        let loader = TokmeterLoader(startPolling: false)
        let now = Date(timeIntervalSince1970: 1_795_760_000)

        // Fresh healthy state (< 15s old) skips redundant reloads
        loader.isDaemonAlive = true
        loader.isWarming = false
        loader.lastError = nil
        loader.partialStaleSections = []
        loader.lastSuccessfulFetchAt = now.addingTimeInterval(-5)
        XCTAssertFalse(loader.shouldReloadOnPopoverOpen(now: now))

        // Older than 15s reloads
        loader.lastSuccessfulFetchAt = now.addingTimeInterval(-20)
        XCTAssertTrue(loader.shouldReloadOnPopoverOpen(now: now))

        // Reset to fresh and test day rollover (>24h / different calendar day)
        loader.lastSuccessfulFetchAt = now.addingTimeInterval(-86_400)
        XCTAssertTrue(loader.shouldReloadOnPopoverOpen(now: now))

        // Partial failures, errors, warming, or offline trigger reload
        loader.lastSuccessfulFetchAt = now.addingTimeInterval(-2)
        loader.partialStaleSections = ["bar-snapshot"]
        XCTAssertTrue(loader.shouldReloadOnPopoverOpen(now: now))

        loader.partialStaleSections = []
        loader.lastError = "Network lost"
        XCTAssertTrue(loader.shouldReloadOnPopoverOpen(now: now))

        loader.lastError = nil
        loader.isWarming = true
        XCTAssertTrue(loader.shouldReloadOnPopoverOpen(now: now))

        loader.isWarming = false
        loader.isDaemonAlive = false
        XCTAssertTrue(loader.shouldReloadOnPopoverOpen(now: now))
    }

    @MainActor
    func testDaemonEventStreamParsesPushEventsAndIgnoresOtherFrames() {
        let warmed = DaemonEventStream.parseEvent(
            from: #"{"type":"daemon_event","event":"core_warmed","computedAt":1795760000000,"localDate":"2026-11-27"}"#
        )
        XCTAssertEqual(
            warmed,
            DaemonPushEvent(type: "daemon_event", event: "core_warmed", computedAt: 1_795_760_000_000, localDate: "2026-11-27")
        )
        XCTAssertNil(DaemonEventStream.parseEvent(from: #"{"type":"ack","success":true}"#))
        XCTAssertNil(DaemonEventStream.parseEvent(from: "not json"))
    }

    func testDaemonClientRetriesOnceOnTransientNetworkConnectionLost() async throws {
        SequenceURLProtocol.reset()
        SequenceURLProtocol.handler = { request, attempt in
            XCTAssertEqual(request.timeoutInterval, DaemonClient.fastGetTimeout)
            if attempt == 1 {
                return (0, nil, URLError(.networkConnectionLost))
            }
            let payload = #"{"ready":true,"warming":false,"apiVersion":1}"#
            return (200, Data(payload.utf8), nil)
        }
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [SequenceURLProtocol.self]
        let client = DaemonClient(pidPaths: [], tokenPaths: [], session: URLSession(configuration: cfg))

        let ready = try await client.fetchReady()
        XCTAssertTrue(ready.ready)
        XCTAssertEqual(ready.apiVersion, 1)
    }

    func testBarSnapshotResponseDecodesWithAndWithoutRefreshingMetadata() throws {
        let legacyJSON = #"{"daily":[],"models":[],"todayModels":[],"sessions":[],"todayProjects":[],"partialErrors":[]}"#
        let legacy = try JSONDecoder().decode(BarSnapshotResponse.self, from: Data(legacyJSON.utf8))
        XCTAssertNil(legacy.refreshing)
        XCTAssertNil(legacy.computedAt)

        let liveJSON = #"{"daily":[],"models":[],"todayModels":[],"sessions":[],"todayProjects":[],"partialErrors":[],"refreshing":true,"computedAt":1795760000123}"#
        let live = try JSONDecoder().decode(BarSnapshotResponse.self, from: Data(liveJSON.utf8))
        XCTAssertEqual(live.refreshing, true)
        XCTAssertEqual(live.computedAt, 1_795_760_000_123)
    }

    @MainActor
    func testDaemonPhaseStaysLiveWhenWarmingWithExistingFreshData() {
        let loader = TokmeterLoader(startPolling: false)
        loader.isDaemonAlive = true
        loader.isWarming = true
        loader.hasFreshData = false
        XCTAssertTrue(loader.showWarmingSkeleton)
        XCTAssertEqual(loader.daemonPhase, .warming)

        loader.hasFreshData = true
        XCTAssertFalse(loader.showWarmingSkeleton)
        XCTAssertEqual(loader.daemonPhase, .live)
    }

    @MainActor
    func testDaemonEventStreamDoesNotRetainSelfAcrossStartStopCycle() async {
        var stream: DaemonEventStream? = DaemonEventStream(
            wsURL: URL(string: "ws://127.0.0.1:1")!,
            tokenProvider: { _ in nil },
            onEvent: { _ in }
        )
        weak let weakStream = stream
        stream?.start()
        try? await Task.sleep(nanoseconds: 30_000_000)
        stream?.stop()
        stream = nil
        await Task.yield()
        XCTAssertNil(weakStream)
    }
}
