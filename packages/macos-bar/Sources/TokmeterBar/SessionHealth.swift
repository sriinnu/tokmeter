// SessionHealth.swift — the menubar's health band + color.
//
// Mirrors packages/core/src/session-health.ts: the same 50/75/90 thresholds
// and worst-session-wins semantics, so the menubar color means exactly what
// the statusline color means. Kept deliberately small and pure.

import SwiftUI

/// Semantic health band, ascending in severity. `nil`/absent readings are not
/// bands — a signal a provider can't produce contributes nothing (no fake ok).
enum HealthBand: Int, Comparable {
    case ok = 0
    case warn = 1
    case high = 2
    case critical = 3

    static func < (lhs: HealthBand, rhs: HealthBand) -> Bool {
        lhs.rawValue < rhs.rawValue
    }

    /// Menubar tint. Uses system semantic colors so it adapts to light/dark.
    var color: Color {
        switch self {
        case .ok: return .green
        case .warn: return .yellow
        case .high: return .orange
        case .critical: return .red
        }
    }

    /// Spoken description for VoiceOver — color is never the only signal.
    var accessibilityName: String {
        switch self {
        case .ok: return "healthy"
        case .warn: return "elevated"
        case .high: return "high"
        case .critical: return "critical"
        }
    }

    /// Map a percentage (0–100+, values above 100 stay critical) to a band.
    /// A non-finite or negative reading is `ok` — an unknown signal never alarms.
    static func forPct(_ pct: Double, warn: Double = 50, high: Double = 75, critical: Double = 90) -> HealthBand {
        guard pct.isFinite, pct >= 0 else { return .ok }
        if pct >= critical { return .critical }
        if pct >= high { return .high }
        if pct >= warn { return .warn }
        return .ok
    }

    /// Worst (highest-severity) band across readings; `nil` inputs are ignored,
    /// and the result is `nil` when nothing can report (no fabricated band).
    static func worst(_ bands: [HealthBand?]) -> HealthBand? {
        bands.compactMap { $0 }.max()
    }
}
