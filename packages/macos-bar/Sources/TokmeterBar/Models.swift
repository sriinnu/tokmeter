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
    /// Per-tier token counts. Optional so legacy wire shapes (CLI offline
    /// fallback, very old daemon builds) don't fail to decode — the UI just
    /// hides the sliver when these are all zero.
    let inputTokens: Int
    let outputTokens: Int
    let cacheReadTokens: Int
    let cacheWriteTokens: Int
    let reasoningTokens: Int
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
    /// Per-tier breakdown emitted by the daemon's `ModelSummary`. Optional
    /// so older wire shapes still decode — we default to 0 in the loader
    /// when they're missing.
    let inputTokens: Int?
    let outputTokens: Int?
    let cacheReadTokens: Int?
    let cacheWriteTokens: Int?
    let reasoningTokens: Int?
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

/// /api/anomalies — kosha-detected pricing rate movements >25% in the last
/// 24h. Surfaces "rate moved unexpectedly" — the failure mode the unpriced
/// detector can't catch (kosha returned a wrong number, not null).
struct PricingAnomaly: Codable, Identifiable {
    let ts: Double
    let key: String
    let field: String
    let side: String
    let previous: Double
    let current: Double
    let deltaPct: Double

    var id: String { "\(key)|\(field)|\(side)|\(ts)" }
}

struct AnomaliesResponse: Codable {
    let anomalies: [PricingAnomaly]
    let total: Int
    let cappedAt: Int
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

// MARK: - Statbar signals (/api/statbar-signals)

/// Live "how am I doing right now" signals. Mirror of the TS StatbarSignals
/// type in @sriinnu/tokmeter-core. Every field is recomputed against the
/// current wall clock on each fetch, so the bar can watch numbers move
/// instead of just showing totals.
struct BurnRate: Codable, Equatable {
    let costPerHour: Double
    let tokensPerHour: Double
    let windowMinutes: Int
    let recordsInWindow: Int
}

struct CacheHitToday: Codable, Equatable {
    /// 0…1 — share of read tokens served from cache today. 1 = perfect cache.
    let rate: Double
    let cacheReadTokens: Int
    let inputTokens: Int
}

struct PaceSignal: Codable, Equatable {
    /// today.cost / typicalCostAtThisHour. nil when we have no baseline.
    let multiple: Double?
    let typicalCostByNow: Double
    let actualCostByNow: Double
    let daysOfHistory: Int
}

struct CompactionToday: Codable, Equatable {
    let cost: Double
    let tokens: Int
    /// Compaction cost / total today cost, 0…1.
    let share: Double
    let events: Int
}

/// Today's subagent share — Claude Code's Task tool spawns subagents that
/// write to a separate JSONL. Surfacing this share tells the user how much
/// of their cost is going to nested agent work vs. main-session turns.
struct SubagentToday: Codable, Equatable {
    let cost: Double
    let records: Int
    let share: Double
}

struct ReasoningToday: Codable, Equatable {
    /// Reasoning output tokens today (subset of outputTokens for OpenAI-style
    /// providers — Codex, GPT-5.x-codex, etc.). 0 for providers that don't
    /// report reasoning separately.
    let tokens: Int
    /// Total output tokens today — denominator for share.
    let outputTokens: Int
    /// reasoningTokens / outputTokens, 0…1.
    let share: Double
    /// Records with reasoningTokens > 0 today — UI hides the chip when zero.
    let records: Int
}

struct LiveSession: Codable, Equatable {
    let provider: String
    let model: String
    let project: String
    let ageSeconds: Int
    let lastRecordCost: Double
}

/// Today's tool-call cost breakdown. Only Claude Code populates the upstream
/// `toolCalls` field today, so this card is currently a Claude-only signal —
/// the daemon still emits it (empty) for other-provider-only days so the
/// schema stays stable.
struct ToolCallEntry: Codable, Equatable, Identifiable {
    /// Tool name as Claude Code wrote it ("Bash", "Read", "Edit", …).
    let tool: String
    /// USD attributed to this tool today.
    let cost: Double
    /// cost / totalCost — UI uses this for bar widths. 0…1.
    let share: Double
    /// Times this tool was invoked today.
    let calls: Int

    var id: String { tool }
}

struct ToolCallsToday: Codable, Equatable {
    let byTool: [ToolCallEntry]
    let totalCost: Double
    let callCount: Int
    let turnsWithTools: Int
}

/// Claude Pro/Max 5-hour billing window. Anthropic bills Pro/Max subscriptions
/// in 5h buckets — hitting the cap inside a window forces a wait, which is a
/// real failure mode. Surfaces the current block's cost + time remaining so
/// the user can pace before getting kicked out. Other providers don't have
/// this billing model so the daemon emits null for them.
struct BillingWindow: Codable, Equatable {
    let blockNumber: Int
    /// epoch ms — when the current block started.
    let blockStart: Double
    /// epoch ms — when the current block ends.
    let blockEnd: Double
    /// Seconds until blockEnd. Always > 0 when this struct is non-null.
    let remainingSec: Int
    /// (now - blockStart) / 5h × 100, clamped to 0..100.
    let elapsedPct: Double
    /// USD spent in the current block.
    let cost: Double
    /// Total tokens (all kinds) in the current block.
    let tokens: Int
    /// Records in the current block — UI uses this to count turns/messages.
    let records: Int
}

/// /api/cross-tool — projects today's token shape against the user's top
/// lifetime models. "If all of today's tokens had run on model X instead,
/// you'd have spent $Y."
struct CrossToolProjection: Codable, Equatable, Identifiable {
    let model: String
    let provider: String
    let projectedCost: Double
    var id: String { model }
}

struct CrossToolTokens: Codable, Equatable {
    let input: Int
    let output: Int
    let cacheRead: Int
    let cacheWrite: Int
    let reasoning: Int
}

struct CrossToolComparison: Codable, Equatable {
    let todayActualCost: Double
    let todayTokens: CrossToolTokens
    let projections: [CrossToolProjection]
}

struct StatbarSignals: Codable, Equatable {
    let burnRate: BurnRate
    let cacheHitToday: CacheHitToday
    let pace: PaceSignal
    let compactionToday: CompactionToday
    let subagentToday: SubagentToday
    let reasoningToday: ReasoningToday
    let toolCallsToday: ToolCallsToday
    let billingWindow: BillingWindow?
    let liveSession: LiveSession?
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
