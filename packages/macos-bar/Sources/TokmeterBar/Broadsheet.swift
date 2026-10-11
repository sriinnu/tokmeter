// Broadsheet.swift — Paper's newspaper grammar.
//
// Paper used to be stationery: rounded cards, soft shadows, grey pills, red
// money. A broadsheet does structure with ink, not boxes: hairline and
// double rules divide sections, uppercase kickers label them, dotted leaders
// carry the eye from a name to its figure, and money is set in ink. Colour is
// reserved for meaning. Every element here holds real data; nothing is
// decoration dressed as news.

import SwiftUI

/// Paper's ink and stock. One ink for type and rules, one muted ink for
/// secondary lines, the warm stock behind them.
enum Broadsheet {
    static let stock = Color(red: 0.965, green: 0.945, blue: 0.906)   // #F6F1E7
    static let ink = Color(red: 0.078, green: 0.078, blue: 0.078)     // #141414
    static let ink2 = Color(red: 0.165, green: 0.165, blue: 0.165)    // #2A2A2A
    static let muted = Color(red: 0.333, green: 0.333, blue: 0.333)   // #555555, 7:1 on stock

    /// Nameplate and front-page figures: New York at display weights.
    static func display(_ size: CGFloat, weight: Font.Weight = .black) -> Font {
        .system(size: size, weight: weight, design: .serif)
    }

    /// Kicker / dateline type: small, heavy, tracked capitals.
    static let kickerFont = Font.system(size: 9, weight: .heavy)
    static let kickerTracking: CGFloat = 1.4
}

/// A full-width ink rule.
struct InkRule: View {
    var weight: CGFloat = 1
    var color: Color = Broadsheet.ink

    var body: some View {
        Rectangle().fill(color).frame(height: weight).frame(maxWidth: .infinity)
    }
}

/// The masthead's `3px double` rule: two 1pt lines with a 1pt gap.
struct DoubleRule: View {
    var body: some View {
        VStack(spacing: 1) { InkRule(); InkRule() }
    }
}

/// Section label. Inverted (ink chip on stock) for section heads, plain for
/// datelines.
struct Kicker: View {
    let text: String
    var inverted = false
    var color: Color = Broadsheet.ink

    var body: some View {
        Text(text.uppercased())
            .font(Broadsheet.kickerFont)
            .tracking(Broadsheet.kickerTracking)
            .foregroundColor(inverted ? Broadsheet.stock : color)
            .padding(.horizontal, inverted ? 6 : 0)
            .padding(.vertical, inverted ? 2 : 0)
            .background(inverted ? Broadsheet.ink : Color.clear)
    }
}

/// `name ………… $13,745`: a dotted leader between a label and its figure.
struct LeaderDots: View {
    var body: some View {
        Line()
            .stroke(Broadsheet.muted, style: StrokeStyle(lineWidth: 1, dash: [1, 3]))
            .frame(height: 1)
            .frame(minWidth: 12)
            .offset(y: -3)
            .accessibilityHidden(true)
    }

    private struct Line: Shape {
        func path(in rect: CGRect) -> Path {
            Path { p in
                p.move(to: CGPoint(x: rect.minX, y: rect.midY))
                p.addLine(to: CGPoint(x: rect.maxX, y: rect.midY))
            }
        }
    }
}

/// Section head: a 1pt ink rule with an inverted kicker and the count.
struct BroadsheetSectionHead: View {
    let label: String
    let count: Int
    var ruled = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if ruled { InkRule() }
            HStack(spacing: 6) {
                Kicker(text: label, inverted: true)
                if count > 0 {
                    Text("\(count)")
                        .font(Broadsheet.kickerFont)
                        .tracking(Broadsheet.kickerTracking)
                        .foregroundColor(Broadsheet.muted)
                        .monospacedDigit()
                }
                Spacer()
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// Dateline facts, all real: today's date and how many days of usage the
/// ledger holds (the edition number).
enum BroadsheetDateline {
    static func date(_ now: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE, d MMM yyyy"
        return f.string(from: now)
    }

    static func edition(daysRecorded: Int) -> String {
        daysRecorded > 0 ? "No. \(daysRecorded)" : "First edition"
    }
}
