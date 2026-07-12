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
    /// Today's per-tier split for the hero breakdown line. Zero when the
    /// daemon response predates the breakdown fields.
    @Published var todayInputTokens: Int = 0
    @Published var todayOutputTokens: Int = 0
    @Published var todayCachedTokens: Int = 0
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
    /// Current Claude 5-hour billing-block elapsed % (from /api/quick).
    /// nil when there's no active block or the daemon is unreachable.
    @Published var blockPct: Double?

    // State flags
    @Published var lastError: String?
    @Published var isLoading: Bool = false
    @Published var isRefreshingPricing: Bool = false
    @Published var pricingRefreshError: String?
    /// True while a Hub-triggered deep rescan is rebuilding the relay from raw.
    @Published var isRescanning: Bool = false
    @Published var rescanError: String?
    @Published var rescanStartedNotice: Bool = false
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
    /// Antigravity's live credit/model status — whatever the background poll
    /// (if the user turned it on) or a manual "Fetch now" last captured.
    /// Refreshed on every regular loadData() tick since the read itself is
    /// cache-only and cheap; nil until something has actually fetched once.
    @Published var antigravityLive: AntigravityLiveResponse?
    /// True while a manual "Fetch now" request is in flight.
    @Published var isFetchingAntigravityLiveNow: Bool = false
    @Published var antigravityLiveFetchError: String?
    /// Incremented each time a fetch of `antigravityLive` is *issued* — by
    /// the regular loadData() 30s poll OR by fetchAntigravityLiveNow().
    /// Two independent network requests can resolve out of order: the
    /// routine poll can be issued first but its response can land AFTER a
    /// user-triggered manual fetch's response, silently overwriting the
    /// fresher result the user just asked for and watched land. Each
    /// completing request only applies its result if it's still the most
    /// recently ISSUED one — whichever request was issued last always wins,
    /// regardless of which one's network round-trip finishes last.
    private var antigravityLiveGeneration = 0
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
    /// Fast, lightweight poll for JUST the menubar color signal. The full
    /// refresh can be minutes (user-configurable, e.g. 300s) which is far too
    /// slow for a "live" context-fill color, so this ticks every few seconds
    /// and updates only the cheap color inputs (a warm /api/quick read + the
    /// local block cache). Runs only while a fast-changing source is selected.
    private var colorTimer: Timer?
    private static let colorPollSeconds: TimeInterval = 5
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
        startColorTimer()
    }

    private func startColorTimer() {
        colorTimer?.invalidate()
        colorTimer = Timer.scheduledTimer(
            withTimeInterval: Self.colorPollSeconds, repeats: true
        ) { [weak self] _ in
            guard let loader = self else { return }
            Task { @MainActor in await loader.refreshColorSignals() }
        }
    }

    /// Cheap poll of only the live color inputs. Skips the network entirely
    /// unless a fast-changing source (context/block) is selected.
    @MainActor
    func refreshColorSignals() async {
        switch HubConfigStore.shared.config.colorSource {
        case .context:
            // On a failed fetch, clear rather than keep a stale reading — a
            // wrong-but-confident color is worse than a brief neutral tint. A
            // successful fetch with no live session also (correctly) clears it.
            if let quick = try? await client.fetchQuick() {
                self.liveContextFillPct = quick.liveContextFillPct
            } else {
                self.liveContextFillPct = nil
            }
        case .block:
            // Same live daemon round-trip as .context, same clear-on-failure
            // rule — a stale % surviving a daemon restart would be a "live" lie.
            if let quick = try? await client.fetchQuick() {
                self.blockPct = quick.blockElapsedPct
            } else {
                self.blockPct = nil
            }
        case .budget, .off:
            break  // budget uses today's cost (full-refresh cadence); off = no poll
        }
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
        colorTimer?.invalidate()
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
                self.blockPct = quick.blockElapsedPct
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
        antigravityLiveGeneration += 1
        let antigravityLiveIssuedAsGeneration = antigravityLiveGeneration
        async let antigravityLiveTask = fetchAntigravityLiveSafe()

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
            crossToolResult,
            antigravityLiveResult
        ) = await (
            dailyTask, modelsTask, todayModelsTask, sessionsTask, pricingStatusTask,
            cronStatusTask, healthTask, anomaliesTask, signalsTask, crossToolTask,
            antigravityLiveTask
        )

        withTransaction(noAnim) {
            if let daily = dailyResult {
                if let today = daily.last {
                    self.todayCost = today.cost
                    self.todayTokens = today.totalTokens
                    self.todayInputTokens = today.inputTokens ?? 0
                    self.todayOutputTokens = today.outputTokens ?? 0
                    self.todayCachedTokens = (today.cacheReadTokens ?? 0) + (today.cacheWriteTokens ?? 0)
                }
                let mapped = daily.map { DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost) }
                self.allDaily = mapped
                self.recentDaily = Array(mapped.suffix(7))
            }
            if let models = modelsResult {
                self.topModels = models.prefix(5).map(Self.toUsage)
            }
            if let todayMs = todayModelsResult {
                // Quota-billed/activity-only clients (VS Code Copilot,
                // Antigravity) and real-but-unpriced totals (Codex Desktop's
                // SQLite fallback — genuine non-zero tokens, cost honestly
                // left unexposed) both report cost == 0 — a pure cost
                // ranking always buries them under same-day providers that
                // DO report dollars, so "I used X today" silently never
                // shows up. Top 5 by cost stays the primary ranking; up to 3
                // cost==0 entries are appended so today's real usage is
                // never invisible just because it isn't priced.
                let all = todayMs.map(Self.toUsage)
                let ranked = Array(all.prefix(5))
                let rankedKeys = Set(ranked.map { "\($0.provider)/\($0.model)" })
                let activityOnly = all
                    .filter { $0.cost == 0 && !rankedKeys.contains("\($0.provider)/\($0.model)") }
                    .prefix(3)
                self.todayModels = ranked + activityOnly
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
            // Only apply if nothing newer (a manual Fetch now, or another
            // loadData tick) was issued while this request was in flight —
            // see antigravityLiveGeneration's doc comment.
            if let antigravityLive = antigravityLiveResult,
               antigravityLiveIssuedAsGeneration == antigravityLiveGeneration {
                self.antigravityLive = antigravityLive
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

    private func fetchAntigravityLiveSafe() async -> AntigravityLiveResponse? {
        try? await client.fetchAntigravityLive()
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

    /// Trigger a deep rescan (Hub → Deep Rescan). The daemon rebuilds the relay
    /// from raw history in the BACKGROUND and returns immediately, so this
    /// resolves fast; the rebuilt data (and full pace history) lands on a later
    /// refresh. We flag `rescanStartedNotice` so the Hub can confirm it kicked
    /// off — there's no live progress bar because the daemon owns the work.
    func deepRescan() async {
        guard !isRescanning else { return }
        guard client.isDaemonRunning else {
            rescanError = "Daemon offline — start it first, then Deep Rescan."
            return
        }
        isRescanning = true
        rescanError = nil
        rescanStartedNotice = false
        defer { isRescanning = false }
        do {
            try await client.deepRescan()
            rescanStartedNotice = true
        } catch {
            rescanError = error.localizedDescription
        }
    }

    /// One-shot manual fetch of Antigravity's live status — independent of
    /// whether the background polling toggle is on. Updates `antigravityLive`
    /// directly from the fetch response rather than waiting for the next
    /// regular loadData() tick, so the result is visible the moment it lands.
    /// A nil snapshot in an `ok` response isn't an error — it means
    /// Antigravity's language_server wasn't found running.
    func fetchAntigravityLiveNow() async {
        guard !isFetchingAntigravityLiveNow else { return }
        guard client.isDaemonRunning else {
            antigravityLiveFetchError = "Daemon offline — start it first."
            return
        }
        isFetchingAntigravityLiveNow = true
        antigravityLiveFetchError = nil
        defer { isFetchingAntigravityLiveNow = false }
        do {
            let result = try await client.fetchAntigravityLiveNow()
            if !result.ok {
                antigravityLiveFetchError = result.error ?? "Fetch failed"
                return
            }
            if result.snapshot == nil {
                antigravityLiveFetchError = "Antigravity isn't running (or its language_server couldn't be reached)."
            }
            // The generation is captured HERE, immediately before the final
            // read, not at the top of this method — the POST above (the
            // actual scrape) can take a second or two, during which a
            // routine loadData() tick can legitimately issue and resolve its
            // own antigravityLive read first. That's fine; it's not stale
            // relative to OUR result because our fresher data didn't exist
            // yet. What must not happen is THIS read losing to one issued
            // and resolved while it was in flight — narrowing the generation
            // window to just this call is what makes that comparison correct.
            antigravityLiveGeneration += 1
            let myGeneration = antigravityLiveGeneration
            // Re-read the cache-only endpoint rather than hand-assembling
            // AntigravityLiveResponse from the fetch result — it also
            // recomputes creditsUsedToday against the now-updated snapshot
            // history, which the fetch endpoint doesn't return.
            let fresh = try? await client.fetchAntigravityLive()
            if myGeneration == antigravityLiveGeneration {
                antigravityLive = fresh
            }
        } catch {
            antigravityLiveFetchError = error.localizedDescription
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
            provider: d.provider ?? "unknown",
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
