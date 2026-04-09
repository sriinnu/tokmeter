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

    private let client = DaemonClient.shared
    private var timer: Timer?
    private var fetchInFlight: Bool = false

    init() {
        Task { await loadData() }
        // Refresh every 30 seconds. Timer is retained by the run loop and
        // we hold it here so it can be invalidated on deinit.
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in
                await self?.loadData()
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
            self.lastError = DaemonError.daemonNotRunning.errorDescription
            self.hasFreshData = false
            self.isWarming = false
            return
        } catch {
            self.lastError = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
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
}
