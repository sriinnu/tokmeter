// HubCrossToolCard.swift — "If today ran on..." card for the Hub.
//
// Projects today's exact token shape against each of the user's top
// lifetime models. Surfaces the "what would my work have cost on a
// different model" question — useful for routing decisions, especially
// when the user is mixing premium + budget tiers.
//
// Honest about what we can/can't compare: we project against models the
// user has actually used (so kosha has their pricing live), not a
// hardcoded popular-models list. The actual today's cost is highlighted
// so the user can spot which projections are upgrades vs. savings.

import SwiftUI

struct HubCrossToolCard: View {
    let comparison: CrossToolComparison
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    private var actualCost: Double { comparison.todayActualCost }

    /// Cheapest projection — anchor for the savings/upgrade delta.
    private var cheapest: Double {
        comparison.projections.map { $0.projectedCost }.min() ?? actualCost
    }

    var body: some View {
        HubCard(theme: theme) {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("If today ran on…")
                        .font(.system(size: 13, weight: .semibold, design: theme.fonts.labelDesign))
                        .foregroundColor(bg.primaryTextColor)
                    Spacer()
                    Text(String(format: "actual today: $%.2f", actualCost))
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                        .contentTransition(.numericText())
                }
                if comparison.projections.isEmpty {
                    HubEmptyState(
                        icon: "shuffle",
                        message: "No usage history yet — projections need at least one model",
                        theme: theme
                    )
                } else {
                    VStack(spacing: 5) {
                        ForEach(comparison.projections) { p in
                            row(p)
                        }
                    }
                }
            }
        }
    }

    private func row(_ p: CrossToolProjection) -> some View {
        let delta = p.projectedCost - actualCost
        let isSavings = delta < -0.005
        let isUpcharge = delta > 0.005
        let deltaColor: Color =
            isSavings ? Color.tokSuccess
            : isUpcharge ? Color.tokDanger
            : bg.secondaryTextColor
        return HStack(spacing: 10) {
            Image(systemName: glyphFor(provider: p.provider))
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(c.accent)
                .frame(width: 16)
            Text(shortModel(p.model))
                .font(.system(size: 11, weight: .medium, design: theme.fonts.labelDesign))
                .foregroundColor(bg.primaryTextColor)
                .lineLimit(1)
                .truncationMode(.middle)
            Spacer()
            Text(String(format: "$%.2f", p.projectedCost))
                .font(.system(size: 11, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
                .frame(width: 64, alignment: .trailing)
                .contentTransition(.numericText(value: p.projectedCost))
            // "+$2.40" / "−$1.10" / "—"
            Text(deltaText(delta))
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(deltaColor)
                .frame(width: 56, alignment: .trailing)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .help(tooltipFor(p, delta: delta))
    }

    private func deltaText(_ delta: Double) -> String {
        if abs(delta) < 0.005 { return "—" }
        let sign = delta > 0 ? "+" : "−"
        return String(format: "%@$%.2f", sign, abs(delta))
    }

    private func tooltipFor(_ p: CrossToolProjection, delta: Double) -> String {
        let pct = actualCost > 0.0001 ? abs(delta) / actualCost * 100 : 0
        if delta > 0.005 {
            return String(format: "%@: %.0f%% more expensive than today's actual",
                          p.model, pct)
        }
        if delta < -0.005 {
            return String(format: "%@: %.0f%% cheaper than today's actual",
                          p.model, pct)
        }
        return "\(p.model): same cost as today's actual"
    }

    private func shortModel(_ full: String) -> String {
        if let slash = full.firstIndex(of: "/") {
            return String(full[full.index(after: slash)...])
        }
        return full
    }

    /// Provider-tinted glyph. Mirrors the silhouettes the popover uses for
    /// model rows — same vocabulary, same recognition cue.
    private func glyphFor(provider: String) -> String {
        switch provider {
        case "claude-code", "anthropic":     return "sparkle"
        case "codex", "openai":              return "circle.hexagongrid.fill"
        case "gemini", "google":             return "g.circle.fill"
        case "qwen":                          return "diamond.fill"
        case "deepseek":                      return "triangle.fill"
        case "mistral":                       return "m.circle.fill"
        case "llama", "meta":                return "leaf.fill"
        case "kimi", "moonshot":             return "moon.fill"
        case "minimax":                       return "infinity"
        case "grok", "xai":                  return "x.circle.fill"
        default:                              return "waveform.circle"
        }
    }
}
