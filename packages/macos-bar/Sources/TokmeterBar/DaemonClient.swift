// DaemonClient.swift — HTTP client for the Drishti daemon REST API.
//
// The daemon writes its bearer token to /tmp/drishti-daemon.token (mode 0600)
// when started. This client reads the token once at init and includes it on
// every POST request. GET requests are open (read-only telemetry).
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
            return "Drishti daemon is not running. Start it with: drishti daemon start"
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
    /// X-Drishti-API header reports a different MAJOR version, we surface a
    /// clear "incompatible daemon" error instead of failing with a confusing
    /// JSON decode crash.
    static let expectedApiMajor = 1

    private let baseURL = URL(string: "http://127.0.0.1:9877")!
    private let pidPath = "/tmp/drishti-daemon.pid"
    private let tokenPath = "/tmp/drishti-daemon.token"
    private let session: URLSession

    /// Bearer token read once from the token file. nil until first POST attempt.
    private var bearerToken: String? {
        try? String(contentsOfFile: tokenPath, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
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
        guard FileManager.default.fileExists(atPath: pidPath),
              let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
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
        return name == "node" || name == "bun" || name.hasPrefix("drishti")
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
    func fetchSessions() async throws -> [ProjectData] {
        try await get("/api/sessions", as: [ProjectData].self)
    }

    func fetchProjectDetail(_ projectName: String) async throws -> ProjectDetailData {
        let encoded = projectName.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? projectName
        return try await get("/api/projects/\(encoded)", as: ProjectDetailData.self)
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

    /// Trigger a fresh kosha pricing registry pull. Blocks until the upstream
    /// discovery completes (typically 2–5s). Call from a background task.
    func updatePricing() async throws {
        struct UpdatePricingResponse: Decodable {
            let ok: Bool
            let error: String?
        }
        let result = try await get("/api/update-pricing", as: UpdatePricingResponse.self)
        if !result.ok {
            throw DaemonError.networkError(result.error ?? "update-pricing returned ok=false")
        }
    }

    // MARK: - Internal

    private func post<T: Decodable>(_ path: String, body: [String: Any], as type: T.Type) async throws -> T {
        guard isDaemonRunning else { throw DaemonError.daemonNotRunning }

        let url = baseURL.appendingPathComponent(path)
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

    private func get<T: Decodable>(_ path: String, as type: T.Type) async throws -> T {
        guard isDaemonRunning else { throw DaemonError.daemonNotRunning }

        let url = baseURL.appendingPathComponent(path)
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("TokmeterBar/0.1", forHTTPHeaderField: "User-Agent")

        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else {
                throw DaemonError.networkError("non-HTTP response")
            }

            // API version check — header looks like "drishti-api/1" (we only
            // care about MAJOR for breakage). If absent, daemon is old/unknown
            // and we proceed (best-effort) since adding the header is recent.
            if let apiHeader = http.value(forHTTPHeaderField: "X-Drishti-API"),
               let majorStr = apiHeader.split(separator: "/").last,
               let major = Int(majorStr),
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
        } catch {
            throw DaemonError.networkError(error.localizedDescription)
        }
    }
}
