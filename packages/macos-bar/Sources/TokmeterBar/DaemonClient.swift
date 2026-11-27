// DaemonClient.swift — HTTP client for the Tokmeter daemon REST API.
//
// The daemon writes its bearer token under ~/.tokmeter/daemon (mode 0600).
// This client reads it at request time for private GETs and POSTs.
//
// All endpoints live at http://127.0.0.1:9877/api/*

import Darwin   // proc_name() — used by isDaemonRunning to verify the PID
import Foundation

enum DaemonError: Error, LocalizedError {
    case daemonNotRunning
    case versionMismatch(Int)
    case httpError(Int)
    case decodingError(String)
    case networkError(String)

    var errorDescription: String? {
        switch self {
        case .daemonNotRunning:
            return "Tokmeter daemon is not running. Start it with: tokmeter-mcp daemon start"
        case .versionMismatch(let daemonMajor):
            return "Daemon API v\(daemonMajor) is incompatible with this app (expected v\(DaemonClient.expectedApiMajor)). Update either the daemon or this app."
        case .httpError(let code):
            return "HTTP \(code) from daemon API"
        case .decodingError(let msg):
            return "Decode error: \(msg)"
        case .networkError(let msg):
            return "Network: \(msg)"
        }
    }
}

final class DaemonClient {
    static let shared = DaemonClient()

    /// API version this client expects from the daemon. If the daemon's
    /// version header (X-Tokmeter-API, or X-Drishti-API from a daemon that
    /// predates the rename) reports a different MAJOR version, we surface a
    /// clear "incompatible daemon" error instead of failing with a confusing
    /// JSON decode crash.
    static let expectedApiMajor = 1

    /// The daemon's API version header. Daemons before the rename send only
    /// `X-Drishti-API: drishti-api/N`; current ones send both, so the new name
    /// wins and the old one is the fallback.
    static func apiVersionHeader(from http: HTTPURLResponse) -> String? {
        http.value(forHTTPHeaderField: "X-Tokmeter-API")
            ?? http.value(forHTTPHeaderField: "X-Drishti-API")
    }

    /// MAJOR from a header value like "tokmeter-api/1" or "drishti-api/1".
    static func apiMajor(fromHeader value: String) -> Int? {
        value.split(separator: "/").last.flatMap { Int($0) }
    }

    private static let baseURL = URL(string: "http://127.0.0.1:9877")!
    static let wsURL = URL(string: "ws://127.0.0.1:9876")!
    static let fastGetTimeout: TimeInterval = 10
    // Prefer the private canonical file. The /tmp path is compatibility-only
    // and is read with O_NOFOLLOW plus owner/type/size validation below.
    private let pidPaths: [String]
    private let tokenPaths: [String]
    private let session: URLSession
    private let tokenLock = NSLock()
    private var cachedBearerToken: String?

    /// Read a tiny, current-user-owned regular file without following a final
    /// symlink. This keeps legacy /tmp shims from becoming an unbounded read
    /// or a pointer into an unrelated local file.
    static func readOwnedSmallFile(_ path: String, maxBytes: Int) -> (text: String, mtime: TimeInterval)? {
        guard maxBytes > 0 else { return nil }
        let fd = Darwin.open(path, O_RDONLY | O_CLOEXEC | O_NOFOLLOW)
        guard fd >= 0 else { return nil }
        defer { Darwin.close(fd) }

        var info = Darwin.stat()
        guard Darwin.fstat(fd, &info) == 0,
              (info.st_mode & S_IFMT) == S_IFREG,
              info.st_uid == getuid(),
              info.st_size > 0,
              info.st_size <= maxBytes else {
            return nil
        }

        var bytes = [UInt8](repeating: 0, count: Int(info.st_size))
        let count = bytes.withUnsafeMutableBytes { raw in
            Darwin.read(fd, raw.baseAddress, raw.count)
        }
        guard count == bytes.count, let text = String(bytes: bytes, encoding: .utf8) else {
            return nil
        }
        return (text, TimeInterval(info.st_mtimespec.tv_sec))
    }

    func invalidateBearerToken() {
        tokenLock.lock()
        cachedBearerToken = nil
        tokenLock.unlock()
    }

    /// Cached in memory to avoid opening/statting/reading `daemon.token` on
    /// every poll tick; automatically reloaded on 401 Unauthorized.
    func currentBearerToken(forceReload: Bool = false) -> String? {
        if !forceReload {
            tokenLock.lock()
            let cached = cachedBearerToken
            tokenLock.unlock()
            if let cached { return cached }
        }
        var found: String?
        for path in tokenPaths {
            if let token = Self.readOwnedSmallFile(path, maxBytes: 128)?.text
                .trimmingCharacters(in: .whitespacesAndNewlines),
               token.count == 64,
               token.allSatisfy({ $0.isHexDigit }) {
                found = token
                break
            }
        }
        tokenLock.lock()
        cachedBearerToken = found
        tokenLock.unlock()
        return found
    }

    init(
        pidPaths: [String] = [
            NSHomeDirectory() + "/.tokmeter/daemon/daemon.pid",
            "/tmp/drishti-daemon.pid",
        ],
        tokenPaths: [String] = [
            NSHomeDirectory() + "/.tokmeter/daemon/daemon.token",
            "/tmp/drishti-daemon.token", // Compatibility with an older daemon.
        ],
        session: URLSession? = nil
    ) {
        self.pidPaths = pidPaths
        self.tokenPaths = tokenPaths
        if let session {
            self.session = session
        } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 60
            config.timeoutIntervalForResource = 90
            config.requestCachePolicy = .reloadIgnoringLocalCacheData
            self.session = URLSession(configuration: config)
        }
    }

    /// True if the daemon's PID file exists, the process is alive, AND the
    /// process actually looks like a node/bun runtime (not some other process
    /// that happened to inherit the PID, or an attacker that pre-wrote the
    /// PID file in /tmp).
    var isDaemonRunning: Bool {
        guard let pidFile = pidPaths.lazy.compactMap({ Self.readOwnedSmallFile($0, maxBytes: 32) }).first,
              let pid = Int32(pidFile.text.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 0 else {
            return false
        }
        // Process must exist
        guard kill(pid, 0) == 0 else { return false }

        // Verify the PID belongs to a node/bun process. /tmp is world-writable,
        // so any user could pre-create the PID file pointing at an unrelated
        // process. proc_name() reads from kernel-maintained tables (not
        // user-supplied data) so it can't be spoofed by writing to /tmp.
        var nameBuf = [CChar](repeating: 0, count: 128)
        let len = proc_name(pid, &nameBuf, UInt32(nameBuf.count))
        guard len > 0 else { return false }
        let name = String(cString: nameBuf)
        // "drishti" is the pre-rename binary name, kept for compatibility.
        let nameOk = name == "node" || name == "bun" || name.hasPrefix("drishti") || name.hasPrefix("tokmeter")
        guard nameOk else { return false }

        // Stale-PID-file defense: if the daemon crashed and the OS recycled
        // its PID to ANOTHER node/bun (e.g. the user spawned `node repl` in
        // a terminal), proc_name() still says "node" and we'd report a false
        // positive. Compare the PID file's mtime to the process's start time
        // via proc_pidinfo(PROC_PIDTBSDINFO) — if the process started AFTER
        // the PID file was written, it can't be the daemon that wrote it.
        // We allow a 60s slack window to absorb clock skew and the small gap
        // between fork and pidfile write at daemon startup.
        var bsdInfo = proc_bsdinfo()
        let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
        let got = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &bsdInfo, infoSize)
        if got == infoSize {
            // proc_bsdinfo.pbi_start_tvsec is the process start time in
            // seconds since the epoch (kernel-supplied, can't be spoofed).
            let processStart = TimeInterval(bsdInfo.pbi_start_tvsec)
            // Stale PID file: process started >60s AFTER the pidfile was
            // written → the original daemon died and the PID was recycled.
            if processStart > pidFile.mtime + 60 {
                return false
            }
        }
        return true
    }

    // MARK: - GET endpoints (read-only, no auth needed)

    /// Fast endpoint — returns immediately even if the daemon is still
    /// warming up. The `ready` flag tells the UI whether to show real
    /// numbers or a skeleton.
    /// Consolidated Phase-2 snapshot (models, daily, sessions, signals, quota,
    /// health, cron, anomalies, cross-tool, antigravity) in one HTTP call.
    func fetchBarSnapshot() async throws -> BarSnapshotResponse {
        try await get("/api/bar-snapshot", as: BarSnapshotResponse.self, timeout: Self.fastGetTimeout)
    }

    func fetchQuick() async throws -> QuickResponse {
        try await get("/api/quick", as: QuickResponse.self, timeout: Self.fastGetTimeout)
    }

    /// Daemon health/warmup status. Cheap call, never blocks on a scan.
    func fetchReady() async throws -> ReadyResponse {
        try await get("/api/ready", as: ReadyResponse.self, timeout: Self.fastGetTimeout)
    }

    func fetchStats() async throws -> StatsData {
        try await get("/api/stats", as: StatsData.self)
    }

    /// Fetch the live "right now" signals — burn rate, cache hit, pace,
    /// compaction tax, live session. Cheap call (single pass over records).
    func fetchStatbarSignals() async throws -> StatbarSignals {
        try await get("/api/statbar-signals", as: StatbarSignals.self, timeout: Self.fastGetTimeout)
    }

    func fetchDaily() async throws -> [DailyData] {
        try await get("/api/daily", as: [DailyData].self)
    }

    func fetchModels() async throws -> [ModelData] {
        try await get("/api/models", as: [ModelData].self)
    }

    func fetchTodayModels() async throws -> [ModelData] {
        try await get("/api/today-models", as: [ModelData].self)
    }

    /// All sessions across all providers, up to 50 items, sorted by recency.
    /// Used for the expandable session list in the popover.
    func fetchSessions(today: Bool = false) async throws -> [ProjectData] {
        try await get(today ? "/api/sessions?today=true" : "/api/sessions", as: [ProjectData].self)
    }

    func fetchProjectDetail(_ projectName: String) async throws -> ProjectDetailData {
        try await get(Self.projectDetailPath(projectName), as: ProjectDetailData.self)
    }

    static func projectDetailPath(_ projectName: String) -> String {
        // Encode as a single path SEGMENT: .urlPathAllowed leaves "/" intact, so
        // a project name containing "/" or "../" could reshape the request path.
        // Removing "/" from the allowed set forces %2F, keeping the name in one
        // segment (defense-in-depth — the daemon does an in-memory lookup).
        var segmentAllowed = CharacterSet.urlPathAllowed
        segmentAllowed.remove("/")
        let encoded = projectName.addingPercentEncoding(
            withAllowedCharacters: segmentAllowed
        ) ?? projectName
        return "/api/projects/\(encoded)"
    }

    /// Fetch the mtime of ~/.kosha/registry.json so the bar can display
    /// "Pricing fetched 2h ago". Returns 0 if the registry is missing.
    func fetchPricingStatus() async throws -> PricingStatus {
        try await get("/api/pricing-status", as: PricingStatus.self, timeout: Self.fastGetTimeout)
    }

    /// Fetch the daily-cron install + last-run state for the Settings panel.
    func fetchCronStatus() async throws -> CronStatus {
        try await get("/api/cron-status", as: CronStatus.self, timeout: Self.fastGetTimeout)
    }

    /// Fetch unpriced-record counters so the bar can flip to amber when
    /// a model has token usage but no pricing data resolves.
    func fetchHealth() async throws -> HealthStatus {
        struct Wire: Codable {
            let unpricedModels: [String]
            let unpricedRecords: Int
        }
        let w = try await get("/api/health", as: Wire.self, timeout: Self.fastGetTimeout)
        return HealthStatus(unpricedModels: w.unpricedModels, unpricedRecords: w.unpricedRecords)
    }

    /// Fetch kosha's recent pricing anomalies (rate movements >25% in 24h).
    /// Drives the "⚠ N price changes" pill in the bar footer.
    func fetchAnomalies() async throws -> AnomaliesResponse {
        try await get("/api/anomalies", as: AnomaliesResponse.self, timeout: Self.fastGetTimeout)
    }

    /// Project today's tokens against the user's top lifetime models.
    /// Drives the Hub's "If today ran on..." card.
    func fetchCrossToolComparison() async throws -> CrossToolComparison {
        try await get("/api/cross-tool", as: CrossToolComparison.self)
    }

    /// Trigger a fresh kosha pricing registry pull. Blocks until the upstream
    /// discovery completes (typically 2–5s). Call from a background task.
    func updatePricing() async throws {
        struct UpdatePricingResponse: Decodable {
            let ok: Bool
            let error: String?
        }
        // POST (token-gated): update-pricing is a mutation (network fetch +
        // full rescan), so the daemon requires the bearer token — a GET here
        // was CSRF-able by any visited web page.
        let result = try await post("/api/update-pricing", body: [:], as: UpdatePricingResponse.self)
        if !result.ok {
            throw DaemonError.networkError(result.error ?? "update-pricing returned ok=false")
        }
    }

    /// Cache-only read of Antigravity's live credit/model status — never
    /// triggers a fetch itself. Reflects whatever the background poll
    /// interval (if the user turned it on) or a manual "Fetch now" last
    /// captured; nil fields mean nothing has been captured yet.
    func fetchAntigravityLive() async throws -> AntigravityLiveResponse {
        try await get("/api/antigravity-live", as: AntigravityLiveResponse.self, timeout: Self.fastGetTimeout)
    }

    /// One-shot manual fetch: asks the daemon to poll Antigravity's
    /// language_server right now and return the result inline, independent
    /// of whether the background polling toggle is on. POST + token-gated
    /// for the same CSRF reason as rescan/update-pricing — a GET here would
    /// let any visited webpage trigger it silently.
    func fetchAntigravityLiveNow() async throws -> AntigravityLiveFetchResponse {
        try await post("/api/antigravity-live/fetch", body: [:], as: AntigravityLiveFetchResponse.self)
    }

    /// Trigger a DEEP rescan: re-read raw history and rebuild every sealed relay
    /// day from scratch (also backfills pace's costByHour on older days). This is
    /// the one explicit heavy path — it runs for minutes on a large tree. The
    /// daemon returns immediately (fire-and-forget) and rebuilds in the
    /// background, so this call resolves fast; the fresh data lands on a later
    /// refresh. POST + token-gated for the same CSRF/DoS reason as pricing.
    func deepRescan() async throws {
        struct RescanResponse: Decodable {
            let ok: Bool
            let error: String?
            let started: Bool?
        }
        let result = try await post("/api/rescan", body: [:], as: RescanResponse.self)
        if !result.ok {
            throw DaemonError.networkError(result.error ?? "rescan returned ok=false")
        }
    }

    // MARK: - Internal

    /// Routes already contain their query and escaped path segments. Appending
    /// them as one path component escapes `?` and escapes every `%` again.
    static func requestURL(for path: String) -> URL {
        URL(string: path, relativeTo: baseURL)!.absoluteURL
    }

    private func performAuthorizedRequest(
        _ buildRequest: @escaping (String?) -> URLRequest
    ) async throws -> (Data, HTTPURLResponse) {
        func performAttempt() async throws -> (Data, HTTPURLResponse) {
            let token = currentBearerToken()
            var (data, response) = try await session.data(for: buildRequest(token))
            guard var http = response as? HTTPURLResponse else {
                throw DaemonError.networkError("non-HTTP response")
            }
            if http.statusCode == 401 {
                invalidateBearerToken()
                var refreshed = currentBearerToken(forceReload: true)
                if refreshed == token {
                    // Daemon restart may still be atomically swapping daemon.token.
                    try? await Task.sleep(nanoseconds: 150_000_000)
                    try Task.checkCancellation()
                    invalidateBearerToken()
                    refreshed = currentBearerToken(forceReload: true)
                }
                if let refreshed, !refreshed.isEmpty, refreshed != token {
                    (data, response) = try await session.data(for: buildRequest(refreshed))
                    guard let retryHttp = response as? HTTPURLResponse else {
                        throw DaemonError.networkError("non-HTTP response")
                    }
                    http = retryHttp
                }
            }
            return (data, http)
        }

        do {
            return try await performAttempt()
        } catch let err as URLError where err.code == .networkConnectionLost {
            // Stale keep-alive socket after Mac sleep/wake or daemon restart:
            // wait briefly, reload bearer token in case the daemon restarted, and retry once.
            try? await Task.sleep(nanoseconds: 150_000_000)
            try Task.checkCancellation()
            invalidateBearerToken()
            return try await performAttempt()
        }
    }

    /// Writes need the bearer token. Check the cached bearer token first so
    /// steady-state POSTs avoid per-request `proc_pidinfo` kernel probes.
    private func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
        let token = currentBearerToken()
        guard !(token ?? "").isEmpty || isDaemonRunning else { throw DaemonError.daemonNotRunning }

        let url = Self.requestURL(for: path)
        let bodyData = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, http) = try await performAuthorizedRequest { bearer in
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Accept")
                req.setValue("application/json", forHTTPHeaderField: "Content-Type")
                req.setValue("TokmeterBar/0.1", forHTTPHeaderField: "User-Agent")
                if let bearer, !bearer.isEmpty {
                    req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                }
                req.httpBody = bodyData
                return req
            }
            guard (200..<300).contains(http.statusCode) else {
                throw DaemonError.httpError(http.statusCode)
            }
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw DaemonError.decodingError(error.localizedDescription)
            }
        } catch let err as DaemonError {
            throw err
        } catch let err as URLError where Self.meansNothingListening(err) {
            throw DaemonError.daemonNotRunning
        } catch {
            throw DaemonError.networkError(error.localizedDescription)
        }
    }

    /// Reads validate daemon authenticity via the API version header first,
    /// avoiding synchronous `proc_pidinfo` / pidfile I/O on every request.
    /// On 401 Unauthorized (e.g. daemon restarted with a new bearer token),
    /// invalidates the cached token, reloads from disk, and retries once.
    func get<T: Decodable>(_ path: String, as type: T.Type, timeout: TimeInterval? = nil) async throws -> T {
        let url = Self.requestURL(for: path)

        do {
            let (data, http) = try await performAuthorizedRequest { bearer in
                var req = URLRequest(url: url)
                req.httpMethod = "GET"
                if let timeout { req.timeoutInterval = timeout }
                req.setValue("application/json", forHTTPHeaderField: "Accept")
                req.setValue("TokmeterBar/0.1", forHTTPHeaderField: "User-Agent")
                if let bearer, !bearer.isEmpty {
                    req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization")
                }
                return req
            }

            let apiHeader = Self.apiVersionHeader(from: http)
            if apiHeader == nil && !isDaemonRunning {
                throw DaemonError.daemonNotRunning
            }

            if let apiHeader,
               let major = Self.apiMajor(fromHeader: apiHeader),
               major != Self.expectedApiMajor {
                throw DaemonError.versionMismatch(major)
            }

            guard (200..<300).contains(http.statusCode) else {
                throw DaemonError.httpError(http.statusCode)
            }
            guard data.count <= 10_000_000 else {
                throw DaemonError.networkError("response too large (\(data.count) bytes)")
            }
            do {
                return try JSONDecoder().decode(T.self, from: data)
            } catch {
                throw DaemonError.decodingError(error.localizedDescription)
            }
        } catch let err as DaemonError {
            throw err
        } catch let err as URLError where Self.meansNothingListening(err) {
            throw DaemonError.daemonNotRunning
        } catch {
            throw DaemonError.networkError(error.localizedDescription)
        }
    }

    /// Connection-level failures that mean no daemon is on the port, as
    /// opposed to a daemon that answered badly.
    static func meansNothingListening(_ err: URLError) -> Bool {
        // Only a refused connection. networkConnectionLost is a daemon that
        // dropped mid-response (or a stale keep-alive), not an absent one;
        // treating it as absent wiped good data and spawned a start.
        err.code == .cannotConnectToHost
    }
}
