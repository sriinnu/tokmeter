// DaemonClient.swift — HTTP client for the Drishti daemon REST API.
//
// The daemon writes its bearer token to /tmp/drishti-daemon.token (mode 0600)
// when started. This client reads the token once at init and includes it on
// every POST request. GET requests are open (read-only telemetry).
//
// All endpoints live at http://127.0.0.1:9877/api/*

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
    private let session: URLSession

    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 5
        config.timeoutIntervalForResource = 10
        // No persistent caches: every request is fresh telemetry.
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        self.session = URLSession(configuration: config)
    }

    /// True if the daemon's PID file exists and the process is alive.
    var isDaemonRunning: Bool {
        guard FileManager.default.fileExists(atPath: pidPath),
              let pidStr = try? String(contentsOfFile: pidPath, encoding: .utf8),
              let pid = Int32(pidStr.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            return false
        }
        // kill(pid, 0) succeeds if process exists
        return kill(pid, 0) == 0
    }

    // MARK: - GET endpoints (read-only, no auth needed)

    func fetchStats() async throws -> StatsData {
        try await get("/api/stats", as: StatsData.self)
    }

    func fetchDaily() async throws -> [DailyData] {
        try await get("/api/daily", as: [DailyData].self)
    }

    func fetchModels() async throws -> [ModelData] {
        try await get("/api/models", as: [ModelData].self)
    }

    // MARK: - Internal

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
