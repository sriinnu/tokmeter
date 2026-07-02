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
    /// Live "right now" signals — burn rate, cache hit, pace vs typical,
    /// compaction tax, live session. nil until the first phase-2 fetch.
    @Published var statbarSignals: StatbarSignals?

    /// Worst live context-window fill % across sessions (from /api/quick).
    /// nil when no live session reports a context window.
    @Published var liveContextFillPct: Double?
    /// Current 5-hour billing-block usage %, read from the statusline's block
    /// cache when present (Anthropic-specific). nil when unavailable.
    @Published var blockPct: Double?

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
    /// Today's unpriced-records signal — drives the amber "X models unpriced"
    /// pill in the popover/Hub when non-empty.
    @Published var healthStatus: HealthStatus?
    /// Kosha-detected pricing anomalies (rate moves >25% in last 24h). Drives
    /// the "⚠ N price changes" pill that catches the WORST failure mode —
    /// a wrong rate slipping through every other defense.
    @Published var pricingAnomalies: AnomaliesResponse?
    /// Projection of today's tokens against the user's top lifetime models.
    /// Drives the Hub's "If today ran on..." card.
    @Published var crossToolComparison: CrossToolComparison?
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
    /// Debounce flag for the singleton daemon auto-start. Set true while a
    /// `tokmeter daemon start` spawn is in flight so concurrent poll ticks /
    /// fetches can't launch a stampede of starts. The daemon itself enforces
    /// a PID singleton on disk; this just stops the bar from spamming spawns.
    var isStartingDaemon: Bool = false

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

    /// The statusline writes the 5-hour block calc to this cache; the bar reads
    /// its `elapsed_pct` when the block is active. Anthropic-specific — nil when
    /// the file is absent or the block isn't active.
    private struct BlockCache: Decodable {
        let active: Bool
        let elapsed_pct: Double?
    }

    private static func readBlockPct() -> Double? {
        let base = ProcessInfo.processInfo.environment["XDG_CACHE_HOME"]
            ?? (NSHomeDirectory() as NSString).appendingPathComponent(".cache")
        let path = (base as NSString).appendingPathComponent("tokmeter/statusline-block.json")
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let cache = try? JSONDecoder().decode(BlockCache.self, from: data),
              cache.active, let pct = cache.elapsed_pct, pct.isFinite
        else { return nil }
        return pct
    }

    deinit {
        timer?.invalidate()
    }

    func loadData() async {
        if fetchInFlight { return }
        fetchInFlight = true
        // The 30s poll re-renders the whole Hub. Apply the fetched @Published
        // values inside a non-animating transaction so the refresh is an instant
        // state swap, never an animated layout change: an animated value (e.g.
        // contentTransition numericText, or any implicit .animation) updating a
        // width-greedy card mid-window-Update-Constraints-pass is what re-enters
        // and trips "more Update Constraints passes than there are views".
        var noAnim = Transaction()
        noAnim.disablesAnimations = true
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
            withTransaction(noAnim) {
                self.stats = quick.stats
                self.totalCost = quick.stats.totalCost
                self.totalTokens = quick.stats.totalTokens
                self.liveContextFillPct = quick.liveContextFillPct
                self.blockPct = Self.readBlockPct()
                self.isWarming = !quick.ready
                self.lastError = nil
                if quick.ready {
                    self.hasFreshData = true
                }
            }
        } catch DaemonError.daemonNotRunning {
            // Daemon is offline. We NEVER spawn a per-fetch CLI scan here —
            // each `tokmeter stats --json` cold-reads the whole history into
            // memory (~2GB RSS) and a stampede of those panicked the kernel.
            // Instead we start the singleton daemon once (debounced) and show
            // the warming skeleton; the next poll tick reads from HTTP.
            await handleDaemonOffline()
            return
        } catch {
            // Network error or decode failure — the daemon may be mid-restart
            // or warming. Surface a warming skeleton and try again next tick.
            // Still no CLI scan: reads are daemon-only.
            await handleDaemonOffline()
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
        async let healthTask = fetchHealthSafe()
        async let anomaliesTask = fetchAnomaliesSafe()
        async let signalsTask = fetchStatbarSignalsSafe()
        async let crossToolTask = fetchCrossToolSafe()

        let (
            dailyResult,
            modelsResult,
            todayModelsResult,
            sessionsResult,
            pricingStatusResult,
            cronStatusResult,
            healthResult,
            anomaliesResult,
            signalsResult,
            crossToolResult
        ) = await (
            dailyTask, modelsTask, todayModelsTask, sessionsTask, pricingStatusTask,
            cronStatusTask, healthTask, anomaliesTask, signalsTask, crossToolTask
        )

        withTransaction(noAnim) {
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
                self.topModels = models.prefix(5).map(Self.toUsage)
            }
            if let todayMs = todayModelsResult {
                self.todayModels = todayMs.prefix(5).map(Self.toUsage)
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
            if let health = healthResult {
                self.healthStatus = health
            }
            if let anomalies = anomaliesResult {
                self.pricingAnomalies = anomalies
            }
            if let signals = signalsResult {
                self.statbarSignals = signals
            }
            if let crossTool = crossToolResult {
                self.crossToolComparison = crossTool
            }
        }
    }

    private func fetchCrossToolSafe() async -> CrossToolComparison? {
        try? await client.fetchCrossToolComparison()
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

    private func fetchHealthSafe() async -> HealthStatus? {
        try? await client.fetchHealth()
    }

    private func fetchAnomaliesSafe() async -> AnomaliesResponse? {
        try? await client.fetchAnomalies()
    }

    private func fetchStatbarSignalsSafe() async -> StatbarSignals? {
        try? await client.fetchStatbarSignals()
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

    /// Map the wire shape to the view model. Per-tier counts default to 0
    /// when the daemon (or CLI fallback) didn't emit them — the UI hides
    /// the breakdown sliver cleanly in that case.
    static func toUsage(_ d: ModelData) -> ModelUsage {
        ModelUsage(
            model: d.model,
            cost: d.cost,
            tokens: d.totalTokens,
            inputTokens: d.inputTokens ?? 0,
            outputTokens: d.outputTokens ?? 0,
            cacheReadTokens: d.cacheReadTokens ?? 0,
            cacheWriteTokens: d.cacheWriteTokens ?? 0,
            reasoningTokens: d.reasoningTokens ?? 0
        )
    }
}
