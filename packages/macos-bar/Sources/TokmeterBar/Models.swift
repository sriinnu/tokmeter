// Models.swift — Data shapes returned by the Drishti daemon HTTP REST API.
//
// These mirror the TypeScript types in @sriinnu/tokmeter-core. Keep them
// in sync whenever the daemon API changes.

import Foundation

// MARK: - View models (UI consumes these)

struct DailyUsage: Identifiable, Equatable {
    // Use the date string as the stable ID — a fresh fetch that returns the
    // same days should reuse the existing SwiftUI rows (prevents Chart + row
    // re-renders on every 30s poll).
    var id: String { date }
    let date: String
    let tokens: Int
    let cost: Double
}

struct ModelUsage: Identifiable, Equatable {
    // Model name is the natural stable ID — SwiftUI diffs rows when models
    // are added/removed or reorder, rather than rebuilding them all.
    var id: String { model }
    let model: String
    let cost: Double
    let tokens: Int
}

// MARK: - Wire types (decoded from daemon JSON)

struct StatsData: Codable {
    let totalCost: Double
    let totalTokens: Int
    let activeDays: Int
    let projects: Int
    let longestStreak: Int
}

struct DailyData: Codable {
    let date: String
    let totalTokens: Int
    let cost: Double
}

struct ModelData: Codable {
    let model: String
    let cost: Double
    let totalTokens: Int
    let percentageOfTotal: Double
}

/// /api/quick — fast cached response, may be unready (zeros) on cold start.
struct QuickResponse: Codable {
    let ready: Bool
    let stats: StatsData
}

/// /api/ready — health check.
struct ReadyResponse: Codable {
    let ready: Bool
    let warming: Bool
    let apiVersion: Int
}

/// /api/pricing-status — kosha registry mtime in epoch ms (0 if missing).
struct PricingStatus: Codable {
    let registryMtime: Double
}

/// /api/cron-status — daily-cron install + last-run state.
/// `lastRunOk == nil` means we couldn't tell from the log (e.g. first run
/// hasn't happened yet, or the log was rotated).
struct CronStatus: Codable {
    let installed: Bool
    let lastRunMtime: Double
    let lastRunOk: Bool?
    let lastRunTail: String
}

/// /api/health — surfaces silent $0 pricing leaks. Any non-empty
/// `unpricedModels` means today-records billed at $0 because no pricing tier
/// resolved them — the bar should flip to an amber state so the user notices.
struct HealthStatus: Codable {
    let unpricedModels: [String]
    let unpricedRecords: Int
}

/// /api/sessions — per-project session aggregate.
/// Mirrors the TS ProjectSummary type from @sriinnu/tokmeter-core.
struct ProjectData: Codable, Identifiable {
    let project: String
    let totalCost: Double
    let totalTokens: Int
    let activeDays: Int
    let lastUsed: Double?

    var id: String { project }
}

/// Full CLI output from `tokmeter --json`.
/// Used as the fallback data source when the daemon is offline.
struct TokmeterFullJSON: Codable {
    let stats: StatsData
    let daily: [DailyData]
    let models: [ModelData]
    let projects: [ProjectData]
}

// MARK: - Project drilldown (/api/projects/:name)

struct ModelDetail: Codable, Identifiable {
    let model: String
    let provider: String
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let reasoningTokens: Int
    let totalTokens: Int
    let cost: Double
    let percentageOfTotal: Double

    var id: String { "\(provider)/\(model)" }
}

struct ProviderDetail: Codable, Identifiable {
    let provider: String
    let totalTokens: Int
    let cost: Double
    let models: [String]
    let percentageOfTotal: Double

    var id: String { provider }
}

struct DailyDetail: Codable, Identifiable {
    let date: String
    let totalTokens: Int
    let cost: Double
    let records: Int?

    var id: String { date }
}

struct ProjectDetailData: Codable {
    let project: String
    let totalTokens: Int
    let totalCost: Double
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let reasoningTokens: Int
    let models: [ModelDetail]
    let providers: [ProviderDetail]
    let dailyBreakdown: [DailyDetail]
    let activeDays: Int
    let firstUsed: Double
    let lastUsed: Double
}
