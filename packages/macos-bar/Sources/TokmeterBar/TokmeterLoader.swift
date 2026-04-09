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

    private let client = DaemonClient.shared
    private var timer: Timer?

    init() {
        Task { await loadData() }
        // Refresh every 30 seconds
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
        isLoading = true
        defer { isLoading = false }

        do {
            // Fetch in parallel — three independent endpoints
            async let statsTask = client.fetchStats()
            async let dailyTask = client.fetchDaily()
            async let modelsTask = client.fetchModels()

            let (stats, daily, models) = try await (statsTask, dailyTask, modelsTask)

            self.stats = stats
            self.totalCost = stats.totalCost
            self.totalTokens = stats.totalTokens
            self.lastError = nil

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
        } catch {
            self.lastError = (error as? LocalizedError)?.errorDescription
                ?? error.localizedDescription
        }
    }
}
