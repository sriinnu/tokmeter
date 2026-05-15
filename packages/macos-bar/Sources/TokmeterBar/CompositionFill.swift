// CompositionFill.swift — Shared "model token composition → gradient" logic.
//
// Lifted out of DataSections so HubTopLists can use the same vocabulary.
// The popover and the Hub now speak the same color language: a green-leaning
// bar means cache-dominant regardless of which surface you're looking at.

import SwiftUI

/// Tier identity for the composition fill. Same five buckets every parser
/// emits — output, cacheRead, cacheWrite, input, reasoning.
enum TokenTier {
    case output, cacheRead, cacheWrite, input, reasoning
}

/// Solid + tint threshold. Bar goes solid when one tier ≥ 0.50 of total
/// tokens; the same threshold drives the $cost tint to avoid the "rainbow
/// bar, monochrome $" mismatch.
let TIER_DOMINANT_THRESHOLD: Double = 0.50

/// Sub-tier merge threshold — anything <0.15 absorbs into the next-largest.
let TIER_MERGE_THRESHOLD: Double = 0.15

/// Map a tier to its theme-tinted color. Same vocabulary used in
/// SignalsRibbon and HubPulseCard so a "green model" reads as cache-healthy
/// everywhere.
func tierColor(_ tier: TokenTier, theme: AppTheme) -> Color {
    let c = theme.colors
    switch tier {
    case .output:     return c.warm
    case .cacheRead:  return Color.tokSuccess
    case .cacheWrite: return c.accent
    case .input:      return c.secondary
    case .reasoning:  return c.tertiary
    }
}

/// Build a composition fill from per-tier token counts. Two signals from one
/// visual element: length encodes cost share (caller decides), color shape
/// encodes "what this model spent its tokens on."
///
/// Mitigations:
///   1. ≥50% in one tier → solid color (clearest read; real coding sessions
///      land in ~45/30/20 shape, so 50% catches most dominant patterns).
///   2. Sub-15% tiers absorbed into the next-largest.
///   3. Cap at top 2 tiers (three bands need ~33pt each at the smallest
///      render size; the median row has ~85pt of fill).
///   4. Always sorted dominant→tail.
///
/// Falls back to a `fallback` gradient when token data is missing — caller
/// passes the prior chrome so the bar still looks like itself on legacy
/// wire shapes / CLI fallback path.
func compositionFill(
    output: Int,
    cacheRead: Int,
    cacheWrite: Int,
    input: Int,
    reasoning: Int,
    theme: AppTheme,
    fallback: LinearGradient
) -> LinearGradient {
    let raw: [(TokenTier, Int)] = [
        (.output, output),
        (.cacheRead, cacheRead),
        (.cacheWrite, cacheWrite),
        (.input, input),
        (.reasoning, reasoning),
    ]
    let total = raw.reduce(0) { $0 + $1.1 }
    guard total > 0 else { return fallback }
    let sorted = raw.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }
    let dominantShare = Double(sorted[0].1) / Double(total)
    if dominantShare >= TIER_DOMINANT_THRESHOLD {
        let color = tierColor(sorted[0].0, theme: theme)
        return LinearGradient(colors: [color, color], startPoint: .leading, endPoint: .trailing)
    }
    var working = sorted
    var i = 1
    while i < working.count {
        let share = Double(working[i].1) / Double(total)
        if share < TIER_MERGE_THRESHOLD {
            let absorbed = working.remove(at: i)
            working[i - 1] = (working[i - 1].0, working[i - 1].1 + absorbed.1)
        } else {
            i += 1
        }
    }
    let top = Array(working.prefix(2))
    var stops: [Gradient.Stop] = []
    var cursor = 0.0
    let topTotal = Double(top.reduce(0) { $0 + $1.1 })
    for entry in top {
        let frac = Double(entry.1) / topTotal
        let color = tierColor(entry.0, theme: theme)
        stops.append(.init(color: color, location: cursor))
        cursor += frac
        stops.append(.init(color: color, location: min(1.0, cursor)))
    }
    return LinearGradient(stops: stops, startPoint: .leading, endPoint: .trailing)
}

/// Dominant-tier color when one tier crosses TIER_DOMINANT_THRESHOLD,
/// otherwise nil (caller falls back to neutral). Used by `$cost` text tint
/// in the popover model rows.
func dominantTierColor(
    output: Int,
    cacheRead: Int,
    cacheWrite: Int,
    input: Int,
    reasoning: Int,
    theme: AppTheme
) -> Color? {
    let raw: [(TokenTier, Int)] = [
        (.output, output),
        (.cacheRead, cacheRead),
        (.cacheWrite, cacheWrite),
        (.input, input),
        (.reasoning, reasoning),
    ]
    let total = raw.reduce(0) { $0 + $1.1 }
    guard total > 0 else { return nil }
    let sorted = raw.filter { $0.1 > 0 }.sorted { $0.1 > $1.1 }
    let dominantShare = Double(sorted[0].1) / Double(total)
    if dominantShare >= TIER_DOMINANT_THRESHOLD {
        return tierColor(sorted[0].0, theme: theme)
    }
    return nil
}

/// Per-tier composition tooltip string. "output 47% · cache-read 38% · …"
func compositionTooltip(
    output: Int,
    cacheRead: Int,
    cacheWrite: Int,
    input: Int,
    reasoning: Int
) -> String {
    let total = output + cacheRead + cacheWrite + input + reasoning
    guard total > 0 else { return "No token tier data" }
    let pct: (Int) -> Int = { Int(round(Double($0) / Double(total) * 100)) }
    var parts: [String] = []
    if output > 0     { parts.append("output \(pct(output))%") }
    if cacheRead > 0  { parts.append("cache-read \(pct(cacheRead))%") }
    if cacheWrite > 0 { parts.append("cache-write \(pct(cacheWrite))%") }
    if input > 0      { parts.append("input \(pct(input))%") }
    if reasoning > 0  { parts.append("reasoning \(pct(reasoning))%") }
    return parts.joined(separator: " · ")
}
