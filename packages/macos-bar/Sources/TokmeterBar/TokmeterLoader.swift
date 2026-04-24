// TokmeterLoader.swift — observable view model that fetches from the daemon.
//
// Refreshes every 30s via a Timer. Falls back to clear errors when the
// daemon is offline so the user knows to start it.

import Foundation
import SwiftUI

@MainActor
final class TokmeterLoader: ObservableObject {
    // Phase 1 — fast: populated from /api/quick within ~50ms even on a cold daemon
    @Published var totalCost: Double = 0
    @Published var totalTokens: Int = 0
    @Published var todayCost: Double = 0
    @Published var todayTokens: Int = 0
    @Published var stats: StatsData?

    // Phase 2 — details: populated from /api/models, /api/daily, /api/sessions
    // after the fast phase succeeds. Each is independent so partial failure
    // is graceful.
    @Published var topModels: [ModelUsage] = []
    @Published var recentDaily: [DailyUsage] = []
    @Published var sessions: [ProjectData] = []

    // State flags
    @Published var lastError: String?
    @Published var isLoading: Bool = false
    @Published var hasFreshData: Bool = false
    /// True while the daemon is still doing its first cold scan. The UI
    /// shows a shimmer/skeleton instead of "0" zeros.
    @Published var isWarming: Bool = false
    /// Whether the daemon process is currently alive. Updated on each
    /// `loadData()` call so the view never does sync I/O in its body.
    @Published var isDaemonAlive: Bool = false

    private let client = DaemonClient.shared
    private var timer: Timer?
    private var fetchInFlight: Bool = false

    init() {
        Task { await loadData() }
        // Refresh every 30 seconds. Timer is retained by the run loop and
        // we hold it here so it can be invalidated on deinit.
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            guard let loader = self else { return }
            Task { @MainActor in
                await loader.loadData()
            }
        }
    }

    deinit {
        timer?.invalidate()
    }

    func loadData() async {
        if fetchInFlight { return }
        fetchInFlight = true
        isLoading = true
        defer {
            isLoading = false
            fetchInFlight = false
        }

        // Update daemon liveness once per fetch — avoids sync I/O in the view body.
        self.isDaemonAlive = client.isDaemonRunning

        // ─── Phase 1: fast quick endpoint ────────────────────────────
        // Always succeeds in <50ms (no scan triggered). Returns ready=false
        // + zeros if the daemon is still warming. We render a skeleton
        // while warming, then upgrade to real numbers once ready=true.
        do {
            let quick = try await client.fetchQuick()
            self.stats = quick.stats
            self.totalCost = quick.stats.totalCost
            self.totalTokens = quick.stats.totalTokens
            self.isWarming = !quick.ready
            self.lastError = nil
            if quick.ready {
                self.hasFreshData = true
            }
        } catch DaemonError.daemonNotRunning {
            // Daemon is offline — fall back to the CLI subprocess which reads
            // the same session files and scan-cache directly from disk.
            await loadFromCLI()
            return
        } catch {
            // Network error or decode failure — try CLI fallback too
            await loadFromCLI()
            return
        }

        // If still warming, skip phase 2 — those endpoints will block on
        // the first scan. Try again on the next 30s tick.
        if isWarming { return }

        // ─── Phase 2: details (parallel, independent) ────────────────
        // Each fetch is independent — a failure on one doesn't kill the others.
        async let dailyTask = fetchDailySafe()
        async let modelsTask = fetchModelsSafe()
        async let sessionsTask = fetchSessionsSafe()

        let (dailyResult, modelsResult, sessionsResult) = await (
            dailyTask, modelsTask, sessionsTask
        )

        if let daily = dailyResult {
            if let today = daily.last {
                self.todayCost = today.cost
                self.todayTokens = today.totalTokens
            }
            self.recentDaily = daily.suffix(7).map {
                DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost)
            }
        }
        if let models = modelsResult {
            // Show top 5 instead of 3 — the user has many models
            self.topModels = models.prefix(5).map {
                ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
            }
        }
        if let sessionsList = sessionsResult {
            self.sessions = sessionsList
        }
    }

    private func fetchDailySafe() async -> [DailyData]? {
        try? await client.fetchDaily()
    }

    private func fetchModelsSafe() async -> [ModelData]? {
        try? await client.fetchModels()
    }

    private func fetchSessionsSafe() async -> [ProjectData]? {
        try? await client.fetchSessions()
    }

    // ─── CLI fallback (daemon offline) ───────────────────────────────

    /// When the daemon isn't running, spawn `tokmeter --json` as a subprocess
    /// to read the same session files + scan-cache from disk. The output is
    /// cached to `~/.cache/tokmeter/bar-cache.json` with a 120s TTL so we
    /// don't re-scan on every 30s timer tick.
    private func loadFromCLI() async {
        self.isWarming = false

        // Check disk cache first (avoids a 30-60s subprocess on every timer tick)
        let cacheFile = NSHomeDirectory() + "/.cache/tokmeter/bar-cache.json"
        if let cached = readBarCache(path: cacheFile, maxAgeSeconds: 120) {
            applyTokmeterJSON(cached)
            self.lastError = nil
            self.hasFreshData = true
            return
        }

        // Spawn the CLI with JUST stats output (not the full 150MB summary).
        // `tokmeter stats --json` returns ~500 bytes of aggregated stats.
        //
        // Security: we DO NOT shell out via `$SHELL -l -c` — that loads the
        // user's .zshrc/.bashrc which is a code-execution path any malicious
        // dotfile-writer can abuse. Instead we resolve `npx` at known
        // root-owned system paths and exec it directly with a fixed argv.
        // No user-writable PATH entries, no interpolation, no shell metacharacters.
        let npxCandidates = [
            "/opt/homebrew/bin/npx",   // Homebrew (Apple Silicon) — root-owned
            "/usr/local/bin/npx",      // Homebrew (Intel) — root-owned
        ]
        guard let npxPath = npxCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            self.lastError = "Daemon offline; no node toolchain found at /opt/homebrew or /usr/local."
            self.hasFreshData = false
            return
        }
        let args = ["-y", "@sriinnu/tokmeter", "stats", "--json"]

        do {
            let output = try await runProcess(executable: npxPath, arguments: args, timeout: 15)
            guard let data = output.data(using: .utf8) else {
                self.lastError = "CLI returned non-UTF8 output"
                return
            }

            // Write to disk cache for the next 120s
            writeBarCache(data: data, path: cacheFile)

            // Try full summary first (tokmeter --json), fall back to stats-only
            if let full = try? JSONDecoder().decode(TokmeterFullJSON.self, from: data) {
                applyTokmeterJSON(full)
            } else if let statsOnly = try? JSONDecoder().decode(StatsData.self, from: data) {
                // stats --json returns just the StatsData shape (tiny, fast)
                self.stats = statsOnly
                self.totalCost = statsOnly.totalCost
                self.totalTokens = statsOnly.totalTokens
            } else {
                self.lastError = "CLI returned unparseable output"
                return
            }
            self.lastError = nil
            self.hasFreshData = true
        } catch {
            self.lastError = "Daemon offline · CLI: \(error.localizedDescription)"
            self.hasFreshData = false
        }
    }

    private func applyTokmeterJSON(_ data: TokmeterFullJSON) {
        self.stats = data.stats
        self.totalCost = data.stats.totalCost
        self.totalTokens = data.stats.totalTokens

        if let today = data.daily.last {
            self.todayCost = today.cost
            self.todayTokens = today.totalTokens
        }

        self.recentDaily = data.daily.suffix(7).map {
            DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost)
        }

        self.topModels = data.models.prefix(5).map {
            ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
        }

        // Projects sorted by recency
        let sorted = data.projects
            .sorted { ($0.lastUsed ?? 0) > ($1.lastUsed ?? 0) }
        self.sessions = Array(sorted.prefix(50))
    }

    // ─── Disk cache helpers ──────────────────────────────────────────

    private func readBarCache(path: String, maxAgeSeconds: TimeInterval) -> TokmeterFullJSON? {
        guard FileManager.default.fileExists(atPath: path),
              let attrs = try? FileManager.default.attributesOfItem(atPath: path),
              let modified = attrs[.modificationDate] as? Date,
              Date().timeIntervalSince(modified) < maxAgeSeconds,
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode(TokmeterFullJSON.self, from: data) else {
            return nil
        }
        return decoded
    }

    private func writeBarCache(data: Data, path: String) {
        let dir = (path as NSString).deletingLastPathComponent
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: path))
    }

    // ─── Subprocess runner ───────────────────────────────────────────

    private func runProcess(executable: String, arguments: [String], timeout: TimeInterval) async throws -> String {
        try await withCheckedThrowingContinuation { continuation in
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: executable)
            proc.arguments = arguments

            let outPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError = FileHandle.nullDevice

            // Double-resume guard: termination handler and timeout both race to
            // resume the continuation. Only the first caller wins.
            var resumed = false
            let lock = NSLock()
            @Sendable func finish(_ result: Result<String, Error>) {
                lock.lock()
                defer { lock.unlock() }
                guard !resumed else { return }
                resumed = true
                switch result {
                case .success(let output): continuation.resume(returning: output)
                case .failure(let error):  continuation.resume(throwing: error)
                }
            }

            proc.terminationHandler = { _ in
                let data = outPipe.fileHandleForReading.readDataToEndOfFile()
                guard let output = String(data: data, encoding: .utf8) else {
                    finish(.failure(DaemonError.decodingError("non-UTF8 CLI output")))
                    return
                }
                finish(.success(output))
            }

            do {
                try proc.run()
            } catch {
                finish(.failure(error))
                return
            }

            // One-shot timeout — no RunLoop spinning, no thread held hostage
            DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + timeout) {
                guard proc.isRunning else { return }
                proc.terminate()
                finish(.failure(DaemonError.networkError("CLI timed out after \(Int(timeout))s")))
            }
        }
    }
}
