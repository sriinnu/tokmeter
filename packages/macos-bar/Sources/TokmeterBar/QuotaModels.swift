// QuotaModels.swift — wire shape of /api/quota.
// Mirrors QuotaWindow in packages/core/src/quota.ts.

import Foundation

struct QuotaWindow: Codable, Identifiable, Equatable {
    let agent: String
    /// "5h", "7d"…
    let window: String
    let windowMinutes: Int
    let usedPct: Double
    /// Epoch seconds.
    let windowStart: Double
    let resetsAt: Double
    /// Epoch ms: when the agent last reported it.
    let sampledAt: Double
    let plan: String?
    let creditsBalance: Double?
    let avgPctPerHour: Double
    let recentPctPerHour: Double?
    /// Epoch seconds; nil when the window resets first.
    let hitsLimitAt: Double?
    /// "resets-first" | "hits-limit" | "at-limit" | "expired"
    let verdict: String

    var id: String { "\(agent):\(windowMinutes)" }

    var agentLabel: String {
        switch agent {
        case "codex": return "Codex"
        case "claude-code": return "Claude Code"
        default: return agent
        }
    }

    /// The pace the forecast used: recent when there is one.
    var pacePctPerHour: Double { recentPctPerHour ?? avgPctPerHour }

    /// Whether the window needs attention: out, or running out before reset.
    var isWarning: Bool { verdict == "hits-limit" || verdict == "at-limit" }
}

struct QuotaResponse: Codable {
    let windows: [QuotaWindow]
}
