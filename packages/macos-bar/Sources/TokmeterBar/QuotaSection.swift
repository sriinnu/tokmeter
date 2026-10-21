// QuotaSection.swift — each agent's plan window in the popover: how much is
// used, when it resets, and whether the current pace runs out first.
//
//   PLAN QUOTA
//   Codex · weekly                                   62%
//   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━│━━━━━━━━━━━━━━━━━━━━━━
//   100% by Thu 09:34 at 2.1%/h · resets Tue 09:12
//
// The tick on the bar is where an even pace would be by now (the share of the
// window already gone). A fill past it is spending faster than the window lasts.

import SwiftUI

struct QuotaSection: View {
    let windows: [QuotaWindow]
    let theme: AppTheme
    var now: Date = Date()

    /// An expired window says nothing until the agent reports the new one.
    private var shown: [QuotaWindow] { windows.filter { $0.verdict != "expired" } }

    var body: some View {
        if !shown.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(label: "PLAN QUOTA", count: 0, theme: theme)
                ForEach(shown) { w in
                    QuotaRow(window: w, theme: theme, now: now)
                }
            }
        }
    }
}

struct QuotaRow: View {
    let window: QuotaWindow
    let theme: AppTheme
    let now: Date

    private var paper: Bool { theme == .paper }
    private var ink: Color { paper ? Broadsheet.ink : theme.backgroundMode.primaryTextColor }
    private var muted: Color { paper ? Broadsheet.muted : theme.backgroundMode.secondaryTextColor }
    /// System orange is ~2.3:1 on the cream skins; a burnt amber clears 4.5:1.
    private var warn: Color {
        theme.backgroundMode.isLight ? Color(red: 0.70, green: 0.33, blue: 0.0) : .orange
    }
    private var fill: Color { window.isWarning ? warn : (paper ? Broadsheet.ink : theme.colors.accent) }
    private var font: Font.Design { paper ? .serif : theme.fonts.bodyDesign }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                Text("\(window.agentLabel) · \(QuotaFormat.windowName(window.window))")
                    .font(.system(size: 12, weight: .medium, design: font))
                    .foregroundColor(ink)
                Spacer()
                Text("\(Int(window.usedPct.rounded()))%")
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(window.isWarning ? warn : ink)
            }
            bar
            Text(QuotaFormat.detail(window, now: now))
                .font(.system(size: 10, design: font))
                .foregroundColor(window.verdict == "hits-limit" ? warn : muted)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .combine)
    }

    private var bar: some View {
        GeometryReader { geo in
            let used = min(max(window.usedPct / 100, 0), 1)
            let span = window.resetsAt - window.windowStart
            let elapsed = span > 0 ? min(max((now.timeIntervalSince1970 - window.windowStart) / span, 0), 1) : 0
            ZStack(alignment: .leading) {
                Capsule().fill(muted.opacity(0.18))
                Capsule().fill(fill).frame(width: geo.size.width * used)
                Rectangle()
                    .fill(ink.opacity(0.55))
                    .frame(width: 1.5, height: 8)
                    .offset(x: geo.size.width * elapsed - 0.75)
            }
        }
        .frame(height: 4)
        .accessibilityHidden(true)
    }
}

enum QuotaFormat {
    static func windowName(_ label: String) -> String {
        switch label {
        case "7d": return "weekly"
        case "5h": return "5-hour"
        default: return label
        }
    }

    /// "Thu 09:34" within the week, a date beyond it.
    static func when(_ epochSeconds: Double, now: Date) -> String {
        let date = Date(timeIntervalSince1970: epochSeconds)
        if date.timeIntervalSince(now) < 6 * 86_400 {
            return date.formatted(.dateTime.weekday(.abbreviated).hour().minute())
        }
        return date.formatted(.dateTime.month(.abbreviated).day().hour().minute())
    }

    static func pace(_ pctPerHour: Double) -> String {
        pctPerHour >= 10 ? String(format: "%.0f%%/h", pctPerHour) : String(format: "%.1f%%/h", pctPerHour)
    }

    static func detail(_ w: QuotaWindow, now: Date) -> String {
        var parts: [String] = []
        switch w.verdict {
        case "at-limit":
            parts.append("Out until \(when(w.resetsAt, now: now))")
        case "hits-limit":
            if let hit = w.hitsLimitAt {
                parts.append("100% by \(when(hit, now: now)) at \(pace(w.pacePctPerHour))")
            }
            parts.append("resets \(when(w.resetsAt, now: now))")
        default:
            parts.append("Resets \(when(w.resetsAt, now: now))")
        }
        // Usage elsewhere on the account shows only at the next reading.
        let ageMinutes = (now.timeIntervalSince1970 * 1000 - w.sampledAt) / 60_000
        if ageMinutes >= 60 {
            parts.append(ageMinutes < 2880
                ? "read \(Int(ageMinutes / 60))h ago"
                : "read \(Int(ageMinutes / 1440))d ago")
        }
        return parts.joined(separator: " · ")
    }
}
