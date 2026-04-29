// TokmeterLoader.swift — observable view model that fetches from the daemon.
//
// Refreshes every 30s via a Timer. Falls back to clear errors when the
// daemon is offline so the user knows to start it.

import Combine
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
    @Published var todayModels: [ModelUsage] = []
    @Published var recentDaily: [DailyUsage] = []
    @Published var allDaily: [DailyUsage] = []
    @Published var sessions: [ProjectData] = []

    // State flags
    @Published var lastError: String?
    @Published var isLoading: Bool = false
    @Published var isRefreshingPricing: Bool = false
    @Published var pricingRefreshError: String?
    /// Epoch ms of the last kosha registry write, 0 if unknown. Drives the
    /// "Pricing fetched 2h ago" footer badge.
    @Published var pricingMtime: Double = 0
    /// Daily-cron install + last-run state for the Settings panel.
    @Published var cronStatus: CronStatus?
    /// True while `tokmeter install-cron` is running. Drives the install
    /// button's spinner.
    @Published var isInstallingCron: Bool = false
    /// Last error from install-cron / uninstall-cron, surfaced in the UI.
    @Published var cronInstallError: String?
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
    private var cancellables: Set<AnyCancellable> = []

    init() {
        Task { await loadData() }
        let initial = HubConfigStore.shared.config.bar.refreshSeconds
        restartTimer(interval: TimeInterval(initial))
        HubConfigStore.shared.$config
            .map(\.bar.refreshSeconds)
            .removeDuplicates()
            .sink { [weak self] interval in
                self?.restartTimer(interval: TimeInterval(interval))
            }
            .store(in: &cancellables)
    }

    private func restartTimer(interval: TimeInterval) {
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: interval, repeats: true) { [weak self] _ in
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
        async let todayModelsTask = fetchTodayModelsSafe()
        async let sessionsTask = fetchSessionsSafe()
        async let pricingStatusTask = fetchPricingStatusSafe()
        async let cronStatusTask = fetchCronStatusSafe()

        let (dailyResult, modelsResult, todayModelsResult, sessionsResult, pricingStatusResult, cronStatusResult) = await (
            dailyTask, modelsTask, todayModelsTask, sessionsTask, pricingStatusTask, cronStatusTask
        )

        if let daily = dailyResult {
            if let today = daily.last {
                self.todayCost = today.cost
                self.todayTokens = today.totalTokens
            }
            let mapped = daily.map { DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost) }
            self.allDaily = mapped
            self.recentDaily = Array(mapped.suffix(7))
        }
        if let models = modelsResult {
            // Show top 5 instead of 3 — the user has many models
            self.topModels = models.prefix(5).map {
                ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
            }
        }
        if let todayMs = todayModelsResult {
            self.todayModels = todayMs.prefix(5).map {
                ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
            }
        }
        if let sessionsList = sessionsResult {
            self.sessions = sessionsList
        }
        if let pricing = pricingStatusResult {
            self.pricingMtime = pricing.registryMtime
        }
        if let cron = cronStatusResult {
            self.cronStatus = cron
        }
    }

    private func fetchDailySafe() async -> [DailyData]? {
        try? await client.fetchDaily()
    }

    private func fetchPricingStatusSafe() async -> PricingStatus? {
        try? await client.fetchPricingStatus()
    }

    private func fetchCronStatusSafe() async -> CronStatus? {
        try? await client.fetchCronStatus()
    }

    private func fetchModelsSafe() async -> [ModelData]? {
        try? await client.fetchModels()
    }

    private func fetchTodayModelsSafe() async -> [ModelData]? {
        try? await client.fetchTodayModels()
    }

    private func fetchSessionsSafe() async -> [ProjectData]? {
        try? await client.fetchSessions()
    }

    // ─── Pricing refresh ─────────────────────────────────────────────

    /// Pull the latest kosha pricing registry and reload data.
    /// When the daemon is running: hits POST /api/update-pricing.
    /// When offline: runs `tokmeter update` via the CLI subprocess.
    func refreshPricing() async {
        guard !isRefreshingPricing else { return }
        isRefreshingPricing = true
        pricingRefreshError = nil
        defer { isRefreshingPricing = false }

        if client.isDaemonRunning {
            do {
                try await client.updatePricing()
                await loadData()
            } catch {
                pricingRefreshError = error.localizedDescription
            }
        } else {
            await refreshPricingViaCLI()
        }
    }

    // ─── Cron install/uninstall via CLI subprocess ──────────────────

    /// Spawn `tokmeter install-cron` (or uninstall) as a subprocess. The CLI
    /// writes the launchd plist under ~/Library/LaunchAgents and bootstraps
    /// it with launchctl — we don't replicate that logic in Swift, we just
    /// invoke the CLI so there's a single source of truth for the plist.
    func installCron() async { await runCronCommand("install-cron") }
    func uninstallCron() async { await runCronCommand("uninstall-cron") }

    private func runCronCommand(_ subcommand: String) async {
        guard !isInstallingCron else { return }
        isInstallingCron = true
        cronInstallError = nil
        defer { isInstallingCron = false }

        let npxCandidates = [
            "/opt/homebrew/bin/npx",
            "/usr/local/bin/npx",
        ]
        guard let npxPath = npxCandidates.first(where: {
            FileManager.default.fileExists(atPath: $0)
        }) else {
            cronInstallError =
                "No node toolchain found — run `tokmeter \(subcommand)` manually."
            return
        }
        do {
            _ = try await runProcess(
                executable: npxPath,
                arguments: ["-y", "@sriinnu/tokmeter", subcommand],
                timeout: 30
            )
            // Refresh cronStatus from the daemon so the UI reflects the change.
            await loadData()
        } catch {
            cronInstallError =
                "\(subcommand) failed: \(error.localizedDescription)"
        }
    }

    private func refreshPricingViaCLI() async {
        let npxCandidates = [
            "/opt/homebrew/bin/npx",
            "/usr/local/bin/npx",
        ]
        guard let npxPath = npxCandidates.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            pricingRefreshError = "No node toolchain found — run `tokmeter update` manually."
            return
        }
        do {
            _ = try await runProcess(executable: npxPath,
                                     arguments: ["-y", "@sriinnu/tokmeter", "update"],
                                     timeout: 30)
            // Bust the bar-cache so next load gets repriced data
            let cacheFile = NSHomeDirectory() + "/.cache/tokmeter/bar-cache.json"
            try? FileManager.default.removeItem(atPath: cacheFile)
            await loadData()
        } catch {
            pricingRefreshError = "Pricing update failed: \(error.localizedDescription)"
        }
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

        let mappedDaily = data.daily.map { DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost) }
        self.allDaily = mappedDaily
        self.recentDaily = Array(mappedDaily.suffix(7))

        self.topModels = data.models.prefix(5).map {
            ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
        }

        // Today's model breakdown isn't available from the CLI summary — daemon required.
        self.todayModels = []

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
