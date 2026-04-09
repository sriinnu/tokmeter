// Models.swift — Data shapes returned by the Drishti daemon HTTP REST API.
//
// These mirror the TypeScript types in @sriinnu/tokmeter-core. Keep them
// in sync whenever the daemon API changes.

import Foundation

// MARK: - View models (UI consumes these)

struct DailyUsage: Identifiable {
    let id = UUID()
    let date: String
    let tokens: Int
    let cost: Double
}

struct ModelUsage: Identifiable {
    let id = UUID()
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
