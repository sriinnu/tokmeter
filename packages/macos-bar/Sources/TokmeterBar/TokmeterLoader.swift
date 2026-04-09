// TokmeterLoader.swift — observable view model that fetches from the daemon.
//
// Refreshes every 30s via a Timer. Falls back to clear errors when the
// daemon is offline so the user knows to start it.

import Foundation
import SwiftUI

@MainActor
final class TokmeterLoader: ObservableObject {
    @Published var totalCost: Double = 0
    @Published var totalTokens: Int = 0
    @Published var todayCost: Double = 0
    @Published var todayTokens: Int = 0
    @Published var topModels: [ModelUsage] = []
    @Published var recentDaily: [DailyUsage] = []
    @Published var stats: StatsData?
    @Published var lastError: String?
    @Published var isLoading: Bool = false
    /// True when we have at least one successful fetch. Used to dim stale
    /// values when the daemon goes down between refreshes.
    @Published var hasFreshData: Bool = false

    private let client = DaemonClient.shared
    private var timer: Timer?
    /// Reentrancy guard — prevents two loadData() calls from interleaving
    /// when the user spam-clicks refresh or the timer fires mid-fetch.
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
        // Reentrancy guard: drop concurrent calls instead of interleaving them.
        if fetchInFlight { return }
        fetchInFlight = true
        isLoading = true
        defer {
            isLoading = false
            fetchInFlight = false
        }

        // Retry with exponential backoff for transient daemon-not-ready errors.
        // Max 3 attempts: 0s, 0.5s, 1s. Total worst case ~1.5s + request time.
        var attempt = 0
        let maxAttempts = 3
        while attempt < maxAttempts {
            do {
                try await fetchOnce()
                return
            } catch DaemonError.daemonNotRunning {
                // No point retrying if daemon isn't even running
                self.lastError = DaemonError.daemonNotRunning.errorDescription
                self.hasFreshData = false
                return
            } catch {
                attempt += 1
                if attempt >= maxAttempts {
                    self.lastError = (error as? LocalizedError)?.errorDescription
                        ?? error.localizedDescription
                    // Don't clear stale numbers — let the user see what we last
                    // knew with a "stale" indicator (hasFreshData stays true if
                    // we had data before; UI dims it).
                    return
                }
                let backoff = UInt64(500_000_000) << (attempt - 1) // 0.5s, 1s
                try? await Task.sleep(nanoseconds: backoff)
            }
        }
    }

    private func fetchOnce() async throws {
        // Fetch in parallel — three independent endpoints
        async let statsTask = client.fetchStats()
        async let dailyTask = client.fetchDaily()
        async let modelsTask = client.fetchModels()

        let (stats, daily, models) = try await (statsTask, dailyTask, modelsTask)

        self.stats = stats
        self.totalCost = stats.totalCost
        self.totalTokens = stats.totalTokens
        self.lastError = nil
        self.hasFreshData = true

        // Today = last entry in daily (sorted ascending)
        if let today = daily.last {
            self.todayCost = today.cost
            self.todayTokens = today.totalTokens
        } else {
            self.todayCost = 0
            self.todayTokens = 0
        }

        self.topModels = models.prefix(3).map {
            ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
        }

        self.recentDaily = daily.suffix(7).map {
            DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost)
        }
    }
}
