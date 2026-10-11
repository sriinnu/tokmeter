// Skin+Rams.swift — the "Rams" skin: a Braun ET66-style calculator.
//
// Less, but better. A warm light-grey body, one dark display slab for today's
// figures, a Braun clock dial for the 5-hour billing block, printed key
// legends for labels, and perforation dots for every proportion. Colour only
// where it carries meaning: yellow is money on the display and the elapsed
// block, green is live, amber/red only when a reading needs attention.

import SwiftUI

enum RamsSkin: SkinSpec {
    // Body and inks. Contrast on `surface` (#D6D4CF): ink 10.6:1, muted 5.1:1.
    static let body = Color(red: 0.839, green: 0.831, blue: 0.812)      // #D6D4CF
    static let ink = Color(red: 0.137, green: 0.137, blue: 0.129)       // #232321
    static let muted = Color(red: 0.333, green: 0.325, blue: 0.306)     // #55534E
    static let legend = Color(red: 0.659, green: 0.651, blue: 0.627)    // #A8A6A0 (on slab)
    static let unlit = Color(red: 0.725, green: 0.718, blue: 0.694)     // #B9B7B1
    static let face = Color(red: 0.945, green: 0.937, blue: 0.914)      // #F1EFE9
    static let yellow = Color(red: 1.0, green: 0.824, blue: 0.227)      // #FFD23A (on slab)
    static let yellowDeep = Color(red: 0.910, green: 0.663, blue: 0.0)  // #E8A900
    static let live = Color(red: 0.235, green: 0.604, blue: 0.290)      // #3C9A4A

    static let displayName = "Rams"
    static let tagline = "Calculator, colour only for meaning"
    static let icon = "plus.forwardslash.minus"
    static let surface = body
    static let isLight = true
    static var gradient: [Color] { [surface, surface] }
    static let palette = ThemeColors(
        primary: ink,
        secondary: muted,
        accent: ink,
        highlight: Color(red: 0.42, green: 0.32, blue: 0.0),   // #6B5200, 5.0:1
        warm: muted,
        tertiary: live
    )
    static let fonts = ThemeFonts(heroDesign: .monospaced, heroWeight: .regular,
                                  valueDesign: .monospaced, valueWeight: .regular,
                                  labelDesign: .default, bodyDesign: .default)
    static var costInk: Color { ink }
    static let cornerRadius: CGFloat = 10

    @MainActor static func weekChart(days: [DailyUsage], style: WeekChartStyle, theme: AppTheme) -> AnyView? {
        AnyView(WeekDots(days: days, theme: theme))
    }

    @MainActor static func modelTabs(showToday: Binding<Bool>, theme: AppTheme) -> AnyView? {
        AnyView(HStack(spacing: 6) {
            RoundKey(label: "All", pressed: !showToday.wrappedValue) { showToday.wrappedValue = false }
            RoundKey(label: "Today", pressed: showToday.wrappedValue) { showToday.wrappedValue = true }
        })
    }

    @MainActor static func disclosureLabel(expanded: Bool, theme: AppTheme) -> AnyView? {
        AnyView(HStack(spacing: 8) {
            ZStack {
                Circle().fill(expanded ? ink : face)
                    .overlay(Circle().strokeBorder(ink.opacity(0.35), lineWidth: 0.5))
                Text(expanded ? "−" : "+")
                    .font(mono(11, .medium))
                    .foregroundColor(expanded ? face : ink)
            }
            .frame(width: 18, height: 18)
            .accessibilityHidden(true)
            legendText("Usage details", color: ink)
            Spacer(minLength: 0)
        })
    }

    @MainActor static func footnote(_ text: String, theme: AppTheme) -> AnyView? {
        AnyView(Text(text)
            .font(.system(size: 9.5))
            .foregroundColor(muted)
            .fixedSize(horizontal: false, vertical: true))
    }

    /// Printed key legend: small, semibold, tracked capitals.
    static func legendText(_ text: String, color: Color = muted) -> some View {
        Text(text.uppercased())
            .font(.system(size: 9.5, weight: .semibold))
            .tracking(0.8)
            .foregroundColor(color)
            .lineLimit(1)
    }

    static func mono(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    static var hairline: some View {
        Rectangle().fill(ink.opacity(0.14)).frame(height: 1)
    }

    // MARK: - Hero

    struct Hero: View {
        let header: HeroHeader
        /// Observed directly so the slab redraws on every poll.
        @ObservedObject private var loader: TokmeterLoader

        init(header: HeroHeader) {
            self.header = header
            self.loader = header.loader
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 12) {
                topRow
                slab
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
        }

        private var topRow: some View {
            HStack(spacing: 8) {
                Text("tokmeter")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundColor(ink)
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 4)
                header.cacheWalletToggle
                lamp
            }
            .frame(minHeight: 22)
        }

        /// One lamp, one word. Green only when the numbers are live and fresh.
        private var lamp: some View {
            let (on, word): (Bool, String) = {
                switch loader.daemonPhase {
                case .warming: return (false, "Starting")
                case .offline: return (false, "Offline")
                case .needsNode: return (false, "Needs Node")
                case .live:
                    if loader.lastError != nil && loader.hasFreshData { return (false, "Stale") }
                    if let live = loader.liveSession {
                        return (true, "Live · \(Fmt.projectBasename(live.project))")
                    }
                    return (true, "Live")
                }
            }()
            return HStack(spacing: 5) {
                Circle()
                    .fill(on ? live : unlit)
                    .overlay(Circle().strokeBorder(ink.opacity(0.25), lineWidth: 0.5))
                    .frame(width: 8, height: 8)
                legendText(word, color: on ? ink : muted)
                    .truncationMode(.middle)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Status: \(word)")
        }

        /// The display slab: today's figures, recessed into the body.
        private var slab: some View {
            VStack(alignment: .leading, spacing: 6) {
                switch loader.daemonPhase {
                case .warming:
                    legendText("Today · tokens", color: legend)
                    Text("– – –")
                        .font(mono(36))
                        .foregroundColor(legend.opacity(0.6))
                    Text("Reading usage…")
                        .font(mono(10.5))
                        .foregroundColor(legend)
                case .offline, .needsNode:
                    Text(loader.daemonPhase == .needsNode ? "Node.js required" : "Usage service offline")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(face)
                    Text(loader.daemonPhase == .needsNode
                        ? "Install Node 18+ to run the local service."
                        : "No live numbers. Press ▶ Start below.")
                        .font(mono(10.5))
                        .foregroundColor(legend)
                case .live:
                    HStack {
                        legendText("Today · tokens", color: legend)
                        Spacer()
                        legendText("Est. API cost", color: legend)
                    }
                    HStack(alignment: .firstTextBaseline) {
                        Text(Fmt.number(loader.todayTokens))
                            .font(mono(38))
                            .tracking(-0.8)
                            .foregroundColor(face)
                            .contentTransition(.numericText())
                            .lineLimit(1)
                            .fixedSize()
                        Spacer(minLength: 8)
                        Text(header.estimatedCostText)
                            .font(mono(28))
                            .foregroundColor(yellow)
                            .contentTransition(.numericText())
                            .lineLimit(1)
                            .fixedSize()
                            .help("Usage valued at model API rates. Tool-reported costs are listed separately.")
                    }
                    if let line = footLine {
                        Text(line.text)
                            .font(mono(10.5))
                            .foregroundColor(line.warn ? yellow : legend)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                            .help("API estimates value usage at model rates. Tool-reported costs come from local usage records. Neither is a verified subscription bill.")
                    }
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 10)
                    .fill(ink)
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(Color.black.opacity(0.55), lineWidth: 1.5)
                            .blur(radius: 1.5)
                            .offset(y: 1)
                            .mask(RoundedRectangle(cornerRadius: 10))
                    )
            )
            .overlay(alignment: .bottom) {
                // The body's light catching the slab's lower lip.
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(Color.white.opacity(0.55), lineWidth: 0.5)
                    .mask(LinearGradient(colors: [.clear, .white], startPoint: .center, endPoint: .bottom))
            }
            .accessibilityElement(children: .combine)
        }

        /// The slab's footnote: tool-reported cost and the current burn, or an
        /// honest note when the basis is incomplete.
        private var footLine: (text: String, warn: Bool)? {
            guard let signals = loader.statbarSignals else { return nil }
            var parts: [String] = []
            if let basis = signals.costBasisToday {
                if basis.unavailableRecords > 0 { return ("cost unavailable for some usage", true) }
                if basis.estimatedRecords + basis.reportedRecords == 0 { return ("no usage recorded today", false) }
                if basis.reportedRecords > 0 { parts.append("tool-reported \(Fmt.cost(basis.reportedCost))") }
            }
            if signals.burnRate.recordsInWindow > 0 {
                parts.append("burn \(Fmt.costPerHour(signals.burnRate.costPerHour))")
            }
            return parts.isEmpty ? nil : (parts.joined(separator: " · "), false)
        }
    }

    // MARK: - Signals

    struct Signals: View {
        let items: [SignalsRibbon.Item]
        let theme: AppTheme

        var body: some View {
            let block = items.first { $0.id == "block" }
            let rest = items.filter { $0.id != "block" }
            HStack(alignment: .center, spacing: 16) {
                if let block {
                    BlockDial(item: block)
                        .frame(width: 92, height: 92)
                }
                LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                    GridItem(.flexible(), alignment: .leading)],
                          alignment: .leading, spacing: 10) {
                    ForEach(rest) { item in
                        reading(item)
                    }
                }
            }
            .padding(.vertical, 2)
        }

        private func reading(_ item: SignalsRibbon.Item) -> some View {
            VStack(alignment: .leading, spacing: 1) {
                legendText(item.label)
                Text(item.value)
                    .font(mono(18))
                    .foregroundColor(item.alert ?? ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .contentTransition(.numericText())
                if let sub = item.sub {
                    Text(sub)
                        .font(mono(10))
                        .foregroundColor(muted)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
            }
            .help(item.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(item.label): \(item.value)\(item.sub.map { ", " + $0 } ?? "")")
        }
    }

    /// Braun clock dial for the 5-hour billing block: one full turn = the
    /// block, the yellow hand and arc mark time elapsed, time left printed on
    /// the face.
    struct BlockDial: View {
        let item: SignalsRibbon.Item

        private var elapsed: Double { max(0, min(1, item.elapsed ?? 0)) }

        var body: some View {
            let hand = item.alert ?? yellowDeep
            ZStack {
                Circle().fill(ink)
                Circle().fill(face).padding(5)
                // Elapsed arc just inside the bezel.
                Circle()
                    .trim(from: 0, to: elapsed)
                    .stroke(hand.opacity(0.85), style: StrokeStyle(lineWidth: 3.5, lineCap: .butt))
                    .rotationEffect(.degrees(-90))
                    .padding(9)
                // Twelve ticks, the quarters heavier; six o'clock gives way
                // to the printed time.
                ForEach([0, 1, 2, 3, 4, 5, 7, 8, 9, 10, 11], id: \.self) { i in
                    Rectangle()
                        .fill(ink)
                        .frame(width: i % 3 == 0 ? 1.6 : 0.8, height: i % 3 == 0 ? 7 : 4)
                        .offset(y: -32)
                        .rotationEffect(.degrees(Double(i) * 30))
                }
                Capsule()
                    .fill(hand)
                    .frame(width: 2.4, height: 34)
                    .offset(y: -15)
                    .rotationEffect(.degrees(elapsed * 360))
                Circle().fill(hand).frame(width: 7, height: 7)
                VStack(spacing: 0) {
                    Text(item.value)
                        .font(mono(10.5, .medium))
                        .foregroundColor(ink)
                    Text("LEFT")
                        .font(.system(size: 6.5, weight: .semibold))
                        .tracking(0.6)
                        .foregroundColor(muted)
                }
                .offset(y: 19)
            }
            .help(item.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Billing block: \(item.value) left, \(Int((elapsed * 100).rounded())) percent elapsed")
        }
    }

    // MARK: - Ledger

    struct Ledger: View {
        let rows: [LedgerRowData]
        let theme: AppTheme

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                legendText("All time")
                    .padding(.bottom, 2)
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    line(row)
                    if index < rows.count - 1 { hairline }
                }
            }
        }

        private func line(_ row: LedgerRowData) -> some View {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.name)
                        .font(.system(size: 13))
                        .foregroundColor(ink)
                    // "all time" is already the section's legend.
                    if row.note != "all time" {
                        Text(row.note)
                            .font(.system(size: 9.5))
                            .foregroundColor(muted)
                    }
                }
                Spacer(minLength: 6)
                if !row.spark.isEmpty {
                    DotSpark(values: row.spark)
                        .modifier(SparklineUsageHover(days: row.sparkDays, theme: theme))
                }
                if row.isWarming {
                    ShimmerBar(width: 52, height: 14, breathToggle: true)
                } else {
                    Text(row.value)
                        .font(mono(15))
                        .foregroundColor(row.alert ?? ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .contentTransition(.numericText())
                        .frame(width: 72, alignment: .trailing)
                }
                trend(row)
                    .frame(width: 54, alignment: .trailing)
            }
            .padding(.vertical, 6)
        }

        @ViewBuilder
        private func trend(_ row: LedgerRowData) -> some View {
            if let t = row.trend, !row.isWarming {
                let up = t.percent >= 0
                Text("\(up ? "▲" : "▼")\(String(format: "%.1f", abs(t.percent)))%")
                    .font(mono(10.5))
                    .foregroundColor(t.metric == .cost && up ? theme.statusWarning : muted)
                    .lineLimit(1)
                    .help(t.description)
                    .accessibilityLabel(t.description)
            } else {
                Text("—").font(mono(10.5)).foregroundColor(muted).accessibilityHidden(true)
            }
        }
    }

    /// Perforation sparkline: one column of four dots per recorded day, lit in
    /// proportion to that day's value; the latest day is the last column.
    struct DotSpark: View {
        let values: [Double]

        var body: some View {
            let recent = Array(values.suffix(7))
            let maxV = max(recent.max() ?? 0, 0.0001)
            // Always seven columns so every row's strip lines up; days not
            // yet recorded stay unlit on the left.
            let padded = Array(repeating: 0.0, count: 7 - recent.count) + recent
            HStack(alignment: .bottom, spacing: 2.5) {
                ForEach(Array(padded.enumerated()), id: \.offset) { _, v in
                    let lit = v <= 0 ? 0 : max(1, Int((v / maxV * 4).rounded()))
                    VStack(spacing: 2) {
                        ForEach(0..<4, id: \.self) { row in
                            Circle()
                                .fill(3 - row < lit ? ink : unlit)
                                .frame(width: 3.2, height: 3.2)
                        }
                    }
                }
            }
            .frame(width: 7 * 3.2 + 6 * 2.5, alignment: .trailing)
            .accessibilityHidden(true)
        }
    }

    // MARK: - Keys and the week

    /// A round calculator key. Pressed = ink, sunk; released = face, raised.
    struct RoundKey: View {
        let label: String
        let pressed: Bool
        let action: () -> Void

        var body: some View {
            Button(action: action) {
                Text(label)
                    .font(.system(size: 8.5, weight: .semibold))
                    .foregroundColor(pressed ? face : ink)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(width: 34, height: 34)
                    .background(
                        Circle()
                            .fill(pressed ? ink : face)
                            .shadow(color: .black.opacity(pressed ? 0 : 0.25), radius: 0, x: 0, y: pressed ? 0 : 1.5)
                    )
                    .overlay(Circle().strokeBorder(ink.opacity(pressed ? 0 : 0.2), lineWidth: 0.5))
                    .offset(y: pressed ? 1 : 0)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(pressed ? .isSelected : [])
        }
    }

    /// The week as perforated columns: six dots per day, lit in proportion
    /// to that day's cost. Today, if it's among the recorded days (still
    /// accumulating), is lit in yellow; the last recorded day may be older. Hover a column for its date, tokens and cost.
    struct WeekDots: View {
        let days: [DailyUsage]
        let theme: AppTheme
        @State private var hovered: String?

        private static let rows = 6

        /// Local yyyy-MM-dd, the format DailyUsage dates use.
        private static var todayKey: String { LocalDay.todayKey() }

        var body: some View {
            let maxCost = max(days.map(\.cost).max() ?? 0, 0.0001)
            VStack(spacing: 6) {
                HStack(alignment: .bottom, spacing: 0) {
                    ForEach(Array(days.enumerated()), id: \.element.date) { index, day in
                        let isToday = day.date == Self.todayKey
                        let lit = day.cost <= 0 ? 0 : max(1, Int((day.cost / maxCost * Double(Self.rows)).rounded()))
                        VStack(spacing: 3.5) {
                            Text(day.cost >= 1000 ? Fmt.cost(day.cost) : Fmt.money(day.cost))
                                .font(mono(9, isToday ? .semibold : .regular))
                                .foregroundColor(isToday ? ink : muted)
                                .lineLimit(1)
                                .minimumScaleFactor(0.75)
                            ForEach(0..<Self.rows, id: \.self) { row in
                                Circle()
                                    .fill(Self.rows - 1 - row < lit ? (isToday ? yellowDeep : ink) : unlit)
                                    .frame(width: 7, height: 7)
                            }
                            Text(weekday(day.date))
                                .font(mono(9, isToday ? .semibold : .regular))
                                .foregroundColor(isToday ? ink : muted)
                                .padding(.top, 2)
                        }
                        .frame(maxWidth: .infinity)
                        .contentShape(Rectangle())
                        .onHover { inside in hovered = inside ? day.date : (hovered == day.date ? nil : hovered) }
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("\(LocalDay.pretty(day.date))\(isToday ? ", today so far" : ""): \(Fmt.money(day.cost)), \(Fmt.number(day.tokens)) tokens")
                    }
                }
            }
            .overlay(alignment: .topLeading) {
                if let day = days.first(where: { $0.date == hovered }) {
                    DailyUsageTooltip(day: day, theme: theme)
                        .offset(y: -34)
                        .allowsHitTesting(false)
                }
            }
        }

        /// "2026-09-07" → "Mon". Falls back to the day of month.
        private func weekday(_ date: String) -> String {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd"
            guard let d = f.date(from: date) else { return String(date.suffix(2)) }
            f.dateFormat = "EEE"
            return f.string(from: d)
        }
    }

    // MARK: - Rows

    struct SectionHead: View {
        let label: String
        let count: Int
        let theme: AppTheme

        var body: some View {
            HStack(spacing: 6) {
                legendText(label)
                if count > 0 {
                    Text("\(count)")
                        .font(mono(9.5, .medium))
                        .foregroundColor(muted)
                }
                Spacer()
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        }
    }

    struct ModelRow: View {
        let row: ModelRowData
        let theme: AppTheme

        /// Ten perforations, filled in proportion to the costliest model, in
        /// tenths: $1.05 and $1.00 differ by a fraction of the last dot
        /// instead of rounding to the same ten.
        private var lit: Double {
            guard !row.activityOnly, row.share > 0 else { return 0 }
            return max(0.5, row.share * 10)
        }

        var body: some View {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(row.name)
                            .font(.system(size: 13))
                            .foregroundColor(ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let provider = row.provider {
                            Text(provider)
                                .font(.system(size: 9.5))
                                .foregroundColor(muted)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    HStack(spacing: 2.5) {
                        ForEach(0..<10, id: \.self) { i in
                            let fill = max(0, min(1, lit - Double(i)))
                            Circle()
                                .fill(unlit)
                                .overlay(Circle().fill(ink).opacity(fill))
                                .frame(width: 4, height: 4)
                        }
                    }
                    .help(row.help)
                    .accessibilityHidden(true)
                    Text(row.activityOnly ? "n/a" : Fmt.money(row.model.cost))
                        .font(mono(14))
                        .foregroundColor(row.activityOnly ? muted : ink)
                        .frame(width: 64, alignment: .trailing)
                }
                .padding(.vertical, 6)
                hairline
            }
            .help(row.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(row.name): \(row.activityOnly ? "cost unavailable" : Fmt.money(row.model.cost))")
        }
    }

    struct ProjectRow: View {
        let project: ProjectData
        let theme: AppTheme

        var body: some View {
            VStack(spacing: 0) {
                // One line, like a model row: name, tokens in legend mono,
                // cost on the right.
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Fmt.projectBasename(project.project))
                        .font(.system(size: 13))
                        .foregroundColor(ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help(project.project)
                        .layoutPriority(1)
                    Text("\(Fmt.number(project.totalTokens)) tok")
                        .font(mono(10))
                        .foregroundColor(muted)
                        .lineLimit(1)
                        .fixedSize()
                    Spacer(minLength: 6)
                    Text(Fmt.money(project.totalCost))
                        .font(mono(14))
                        .foregroundColor(ink)
                        .fixedSize()
                }
                hairline.padding(.top, 6)
            }
            .accessibilityElement(children: .combine)
        }
    }

    struct Card: View {
        let role: Color
        var body: some View {
            RoundedRectangle(cornerRadius: RamsSkin.cornerRadius)
                .fill(Color.white.opacity(0.22))
                .overlay(
                    RoundedRectangle(cornerRadius: RamsSkin.cornerRadius)
                        .strokeBorder(RamsSkin.ink.opacity(0.14), lineWidth: 1)
                )
        }
    }
}
