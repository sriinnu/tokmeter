// Formatters.swift — stateless value formatters shared across views.
//
// Kept in one small file so every view that renders a count/cost/model name
// goes through the same presentation rules. No UI, no state — pure string fns.

import Foundation

/// Pure formatting helpers. Used by the hero number, stat cards, and session rows.
enum Fmt {
    /// Compact number: 1_234 → "1.2K", 2_500_000 → "2.5M", 3e9 → "3.0B".
    /// Anything under 1K shows as-is so small counts stay legible.
    /// Unit thresholds sit where the one-decimal rounding would roll over
    /// (999_950 → "1000.0K"), so the next unit takes it: "1.0M".
    static func number(_ n: Int) -> String {
        if n >= 999_950_000 { return String(format: "%.1fB", Double(n) / 1_000_000_000) }
        if n >= 999_950     { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000       { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }

    /// Refresh interval: 30 → "30s", 300 → "5m", 90 → "1m 30s".
    static func interval(_ seconds: Int) -> String {
        guard seconds >= 60 else { return "\(seconds)s" }
        let m = seconds / 60, s = seconds % 60
        return s == 0 ? "\(m)m" : "\(m)m \(s)s"
    }

    /// Currency: $9.99 / $120 / $1.2K / $48K. Decimals only when the number
    /// is small enough to need them; large numbers get integer-K shorthand.
    /// Thresholds are the rounding boundaries, not the round numbers: 99.996
    /// was "$100.00" and 999.6 was "$1000" when the unit was picked first.
    static func cost(_ cost: Double) -> String {
        if cost >= 9_950  { return String(format: "$%.0fK", cost / 1000) }
        if cost >= 999.5  { return String(format: "$%.1fK", cost / 1000) }
        if cost >= 99.995 { return String(format: "$%.0f", cost) }
        return String(format: "$%.2f", cost)
    }

    /// A row's amount, the same everywhere a list shows money: dollars and
    /// cents ("$144.00", "$92.21"), three decimals only below ten cents
    /// ("$0.056") and "<$0.001" below a tenth of a cent. No K/M shorthand:
    /// that's for totals (`cost`), where a missing cent doesn't matter.
    static func money(_ cost: Double) -> String {
        if cost <= 0 { return "$0.00" }
        if cost < 0.001 { return "<$0.001" }
        if cost < 0.10 { return String(format: "$%.3f", cost) }
        if cost >= 100_000 { return Fmt.cost(cost) }
        return "$" + (groupedCents.string(from: NSNumber(value: cost)) ?? String(format: "%.2f", cost))
    }

    /// "1,234.56": thousands grouped, always two decimals, in one fixed
    /// locale so a row never flips to "1.234,56" beside "$0.40".
    private static let groupedCents: NumberFormatter = {
        let f = NumberFormatter()
        f.locale = Locale(identifier: "en_US")
        f.numberStyle = .decimal
        f.usesGroupingSeparator = true
        f.minimumFractionDigits = 2
        f.maximumFractionDigits = 2
        return f
    }()

    /// "1 record" / "3 records": a count with its noun agreeing, never
    /// "record(s)".
    static func count(_ n: Int, _ noun: String, plural: String? = nil) -> String {
        "\(n) \(n == 1 ? noun : (plural ?? noun + "s"))"
    }

    /// True for Claude Code's `<synthetic>` placeholder turns (no tokens, no
    /// cost): not a model anyone chose, so lists leave it out. A synthetic
    /// row that does carry tokens or cost still shows, so totals reconcile.
    static func isEmptySynthetic(model: String, tokens: Int, cost: Double) -> Bool {
        model == "<synthetic>" && tokens == 0 && cost == 0
    }

    /// Cost rate per hour: "$3.20/hr". Below one cent, drops to "—/hr" so a
    /// near-zero burn doesn't read as "$0.00/hr" — which the eye registers
    /// as "I'm not spending anything" instead of "I'm idle right now."
    static func costPerHour(_ cost: Double) -> String {
        if cost < 0.01 { return "—/hr" }
        if cost >= 100 { return String(format: "$%.0f/hr", cost) }
        if cost >= 10  { return String(format: "$%.1f/hr", cost) }
        return String(format: "$%.2f/hr", cost)
    }

    /// Pace multiple: "1.4×" / "0.6×". null → em-dash. Used by the PACE card
    /// to compare today's cost-by-this-hour against the recent baseline.
    static func paceMultiple(_ multiple: Double?) -> String {
        guard let m = multiple else { return "—" }
        if m >= 10 { return String(format: "%.0f×", m) }
        return String(format: "%.1f×", m)
    }

    /// Seconds since the most recent record, compact: "4s" / "47s" / "3m" / "2h".
    static func liveAge(_ seconds: Int) -> String {
        if seconds < 60 { return "\(seconds)s" }
        if seconds < 3600 { return "\(seconds / 60)m" }
        return "\(seconds / 3600)h"
    }

    /// Strip noisy prefixes and dated suffixes from model ids:
    ///   "claude-sonnet-4-5-20250929" → "sonnet-4-5"
    /// Keeps the model table narrow enough to fit 110pt of card width.
    static func shortModel(_ id: String) -> String {
        var name = id
        if name.hasPrefix("claude-") { name = String(name.dropFirst(7)) }
        if let range = name.range(of: #"-\d{8}$"#, options: .regularExpression) {
            name = String(name[..<range.lowerBound])
        }
        return name
    }

    /// Basename of a filesystem-style project key. Handles both `/` and `\`
    /// separators; tolerates leading/trailing whitespace.
    static func projectBasename(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/\\ "))
        let segments = trimmed.split { $0 == "/" || $0 == "\\" }
        return segments.last.map(String.init) ?? path
    }

    /// Error short-text — collapses common daemon error messages into a
    /// single readable status line; anything unknown is truncated at 50ch.
    static func shortError(_ error: String) -> String {
        if error.contains("not running") { return "Daemon offline — using cached data" }
        if error.contains("timed out")   { return "Scan timed out — retrying…" }
        if error.contains("Network")     { return "Network error — using cached data" }
        let first = error.prefix(50)
        return first.count < error.count ? "\(first)…" : error
    }
}
