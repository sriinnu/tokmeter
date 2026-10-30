// TimeOfDay.swift — "Busiest 15–18 · 25% of 30-day cost".
//
// Mirror of core's TimeOfDayProfile (packages/core/src/time-of-day.ts), sent
// on /api/statbar-signals as `timeOfDay`. It is the share of the last 30
// sealed days' COST per 3-hour local block, read from the relay's hourly cost
// curves; the ledger keeps no hourly token curve, so it never says "tokens".

import SwiftUI

struct TimeOfDayBlock: Codable, Equatable {
    let startHour: Int
    let endHour: Int
    let cost: Double
    let share: Double
}

struct TimeOfDayProfile: Codable, Equatable {
    let status: String
    let windowDays: Int
    let minDays: Int
    let daysCounted: Int
    let daysSkipped: Int
    let totalCost: Double
    let blocks: [TimeOfDayBlock]
    let peak: TimeOfDayBlock?

    init(status: String, windowDays: Int, minDays: Int, daysCounted: Int, daysSkipped: Int,
         totalCost: Double, blocks: [TimeOfDayBlock], peak: TimeOfDayBlock?) {
        self.status = status
        self.windowDays = windowDays
        self.minDays = minDays
        self.daysCounted = daysCounted
        self.daysSkipped = daysSkipped
        self.totalCost = totalCost
        self.blocks = blocks
        self.peak = peak
    }

    /// Never throws: StatbarSignals decodes as one unit, so a malformed or
    /// future-shaped profile must not take burn rate, pace and the rest down
    /// with it. Anything unreadable lands as status "invalid" and is hidden.
    init(from decoder: Decoder) throws {
        let c = try? decoder.container(keyedBy: CodingKeys.self)
        status = (try? c?.decode(String.self, forKey: .status)) ?? "invalid"
        windowDays = (try? c?.decode(Int.self, forKey: .windowDays)) ?? 0
        minDays = (try? c?.decode(Int.self, forKey: .minDays)) ?? 0
        daysCounted = (try? c?.decode(Int.self, forKey: .daysCounted)) ?? 0
        daysSkipped = (try? c?.decode(Int.self, forKey: .daysSkipped)) ?? 0
        totalCost = (try? c?.decode(Double.self, forKey: .totalCost)) ?? 0
        blocks = (try? c?.decode([TimeOfDayBlock].self, forKey: .blocks)) ?? []
        peak = (try? c?.decodeIfPresent(TimeOfDayBlock.self, forKey: .peak)) ?? nil
    }

    /// "Busiest 15–18 · 25% of 30-day cost", or nil when there's nothing to
    /// stand behind: not enough days, a malformed split, or no spend at all.
    var busiestLine: String? {
        guard status == "ok", let peak, blocks.count == 8, windowDays > 0,
              peak.share > 0, peak.share <= 1, peak.share.isFinite else { return nil }
        let sum = blocks.reduce(0) { $0 + $1.share }
        guard abs(sum - 1) < 1e-6 else { return nil }
        let pct = Int((peak.share * 100).rounded())
        return "Busiest \(Self.hourLabel(peak.startHour))–\(Self.hourLabel(peak.endHour)) · \(pct)% of \(windowDays)-day cost"
    }

    static func hourLabel(_ hour: Int) -> String {
        hour < 10 ? "0\(hour)" : "\(hour)"
    }
}

/// One compact line under PLAN QUOTA. Absent profile (older daemon) or not
/// enough data: renders nothing.
struct BusiestHoursLine: View {
    let profile: TimeOfDayProfile?
    let theme: AppTheme

    private var paper: Bool { theme == .paper }

    var body: some View {
        if let profile, let line = profile.busiestLine {
            HStack(spacing: 5) {
                Image(systemName: "clock")
                    .font(.system(size: 9, weight: .medium))
                    .accessibilityHidden(true)
                Text(line)
                    .font(paper
                          ? .system(size: 10, design: .serif).italic()
                          : .system(size: 10, design: theme.fonts.bodyDesign).monospacedDigit())
                    .lineLimit(1)
                    .minimumScaleFactor(0.85)
                Spacer(minLength: 0)
            }
            .foregroundColor(paper ? Broadsheet.muted : theme.backgroundMode.secondaryTextColor)
            .help("Share of cost by 3-hour block over the last \(profile.windowDays) sealed days "
                  + "(\(profile.daysCounted) with an hourly curve). Cost, not tokens; today excluded.")
            .accessibilityElement(children: .combine)
        }
    }
}
