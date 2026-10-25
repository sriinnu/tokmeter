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
    // Prefer the private canonical file. The /tmp path is compatibility-only
    // and is read with O_NOFOLLOW plus owner/type/size validation below.
    private let pidPaths = [
        NSHomeDirectory() + "/.tokmeter/daemon/daemon.pid",
        "/tmp/drishti-daemon.pid",
    ]
    private let tokenPaths = [
        NSHomeDirectory() + "/.tokmeter/daemon/daemon.token",
        "/tmp/drishti-daemon.token", // Compatibility with an older daemon.
    ]
    private let session: URLSession

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

    /// Read on each request because a restarted daemon has a new token.
    private var bearerToken: String? {
        for path in tokenPaths {
            if let token = Self.readOwnedSmallFile(path, maxBytes: 128)?.text
                .trimmingCharacters(in: .whitespacesAndNewlines),
               token.count == 64,
               token.allSatisfy({ $0.isHexDigit }) {
                return token
            }
        }
        return nil
    }

    private init() {
        let config = URLSessionConfiguration.default
        // The first request to a cold daemon triggers a full disk scan
        // (potentially hundreds of MB of JSONL across 16 providers). 60s
        // is generous; subsequent calls hit the daemon's 5s in-memory cache.
        config.timeoutIntervalForRequest = 60
        config.timeoutIntervalForResource = 90
        // No persistent caches: every request is fresh telemetry.
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
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
    func fetchQuick() async throws -> QuickResponse {
        try await get("/api/quick", as: QuickResponse.self)
    }

    /// Daemon health/warmup status. Cheap call, never blocks on a scan.
    func fetchReady() async throws -> ReadyResponse {
        try await get("/api/ready", as: ReadyResponse.self)
    }

    func fetchStats() async throws -> StatsData {
        try await get("/api/stats", as: StatsData.self)
    }

    /// Fetch the live "right now" signals — burn rate, cache hit, pace,
    /// compaction tax, live session. Cheap call (single pass over records).
    func fetchStatbarSignals() async throws -> StatbarSignals {
        try await get("/api/statbar-signals", as: StatbarSignals.self)
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
        try await get("/api/pricing-status", as: PricingStatus.self)
    }

    /// Fetch the daily-cron install + last-run state for the Settings panel.
    func fetchCronStatus() async throws -> CronStatus {
        try await get("/api/cron-status", as: CronStatus.self)
    }

    /// Fetch unpriced-record counters so the bar can flip to amber when
    /// a model has token usage but no pricing data resolves.
    func fetchHealth() async throws -> HealthStatus {
        struct Wire: Codable {
            let unpricedModels: [String]
            let unpricedRecords: Int
        }
        let w = try await get("/api/health", as: Wire.self)
        return HealthStatus(unpricedModels: w.unpricedModels, unpricedRecords: w.unpricedRecords)
    }

    /// Fetch kosha's recent pricing anomalies (rate movements >25% in 24h).
    /// Drives the "⚠ N price changes" pill in the bar footer.
    func fetchAnomalies() async throws -> AnomaliesResponse {
        try await get("/api/anomalies", as: AnomaliesResponse.self)
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
        try await get("/api/antigravity-live", as: AntigravityLiveResponse.self)
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

    /// Writes need the bearer token. The pidfile no longer gates them on its
    /// own: it gets reaped while the daemon serves, and the bar then showed a
    /// live daemon whose Rescan said "offline". No pidfile and no token means
    /// there's nothing to authenticate with, so that still reads as offline.
    private func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
        guard isDaemonRunning || !(bearerToken ?? "").isEmpty else { throw DaemonError.daemonNotRunning }

        let url = Self.requestURL(for: path)
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("TokmeterBar/0.1", forHTTPHeaderField: "User-Agent")
        if let token = bearerToken, !token.isEmpty {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)

        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                throw DaemonError.networkError("non-HTTP response")
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
        } catch {
            throw DaemonError.networkError(error.localizedDescription)
        }
    }

    /// Reads don't require the pidfile. /tmp/drishti-daemon.pid gets reaped
    /// while the daemon keeps serving, and gating on it reported a healthy
    /// daemon as offline — which then triggered the auto-start path. The HTTP
    /// answer is the liveness signal. Without a valid pidfile a response must
    /// still carry the daemon's API version header (X-Tokmeter-API, or the
    /// legacy X-Drishti-API). That's a sanity check
    /// that tokmeter answered. Private GETs carry the same bearer as writes.
    /// A refused connection maps to daemonNotRunning so the offline path runs.
    func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        let pidfileValid = isDaemonRunning

        let url = Self.requestURL(for: path)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("TokmeterBar/0.1", forHTTPHeaderField: "User-Agent")
        if let token = bearerToken {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                throw DaemonError.networkError("non-HTTP response")
            }
            let apiHeader = Self.apiVersionHeader(from: http)
            if !pidfileValid && apiHeader == nil {
                throw DaemonError.daemonNotRunning
            }

            // API version check — header looks like "tokmeter-api/1" (or the
            // legacy "drishti-api/1"); we only care about MAJOR for breakage.
            // If absent, daemon is old/unknown and we proceed (best-effort).
            if let apiHeader,
               let major = Self.apiMajor(fromHeader: apiHeader),
               major != Self.expectedApiMajor {
                throw DaemonError.versionMismatch(major)
            }

            guard (200..<300).contains(http.statusCode) else {
                throw DaemonError.httpError(http.statusCode)
            }
            // Defensive cap: any single API response >10MB is suspicious.
            // Protects against an OOM if something else binds 127.0.0.1:9877
            // and returns an unbounded payload (security P1 from perf/security review).
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
