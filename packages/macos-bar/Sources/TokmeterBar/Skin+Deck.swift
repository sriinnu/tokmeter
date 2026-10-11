// Skin+Deck.swift — "Deck": a 1980s hi-fi deck. Tokens as signal.
//
// A brushed-black fascia with smoked VFD windows. Readouts are cyan
// vacuum-fluorescent segments with their unlit "8" ghosts behind them; money
// reads in amber, like a deck's warning lamps. The ratios (cache hit and
// miss, context growth, thinking) are segment level meters, the settled days
// are a spectrum analyser with a peak-hold cap on the biggest day, and each
// model sits on a tuner scale at its cost share.
//
// Kept clear of Terminal on purpose: no green, no scanlines, no CRT bloom.
// Cyan glass and chrome, square-shouldered expanded type for the legends.
// Nothing animates beyond the system's numeric transitions, so there's
// nothing to pause when the panel is hidden or Reduce Motion is on.

import SwiftUI

enum DeckSkin: SkinSpec {
    static let displayName = "Deck"
    static let tagline = "Hi-fi VFD deck"
    static let icon = "waveform"

    /// Brushed fascia, a touch lighter at the top like a lit faceplate.
    static let surface = Color(red: 0.082, green: 0.086, blue: 0.090)        // #151617
    static let isLight = false
    static var gradient: [Color] {
        [Color(red: 0.118, green: 0.122, blue: 0.129), surface]
    }

    // VFD and lamp inks. Contrast on the window (#081214) and fascia:
    // cyan ≈ 13:1, amber ≈ 10:1, legend grey ≈ 8:1.
    static let cyan = Color(red: 0.498, green: 0.941, blue: 0.902)          // #7FF0E6
    static let cyanDim = Color(red: 0.247, green: 0.722, blue: 0.682)       // #3FB8AE
    static let amber = Color(red: 1.0, green: 0.710, blue: 0.278)           // #FFB547
    static let legend = Color(red: 0.663, green: 0.678, blue: 0.698)        // #A9ADB2
    static let face = Color(red: 0.902, green: 0.910, blue: 0.918)          // #E6E8EA
    static let window = Color(red: 0.031, green: 0.071, blue: 0.078)        // #081214
    static let lampRed = Color(red: 1.0, green: 0.416, blue: 0.361)          // #FF6A5C

    static let palette = ThemeColors(
        primary: Color(red: 0.118, green: 0.122, blue: 0.129),
        secondary: cyan,
        accent: cyan,
        highlight: amber,
        warm: cyanDim,
        tertiary: amber
    )
    static let fonts = ThemeFonts(heroDesign: .monospaced, heroWeight: .regular,
                                  valueDesign: .monospaced, valueWeight: .regular,
                                  labelDesign: .default, bodyDesign: .default)
    static var costInk: Color { amber }
    static let cornerRadius: CGFloat = 4

    // MARK: - Type

    /// Engraved fascia legend: small, expanded, tracked capitals.
    static func legendFont(_ size: CGFloat = 8) -> Font {
        .system(size: size, weight: .semibold).width(.expanded)
    }

    static func vfdFont(_ size: CGFloat) -> Font {
        .system(size: size, weight: .regular, design: .monospaced)
    }

    // MARK: - Optional hooks

    @MainActor static func weekChart(days: [DailyUsage], style: WeekChartStyle, theme: AppTheme) -> AnyView? {
        AnyView(CostSpectrum(days: days, theme: theme))
    }

    @MainActor static func modelTabs(showToday: Binding<Bool>, theme: AppTheme) -> AnyView? {
        AnyView(TransportTabs(showToday: showToday))
    }

    @MainActor static func disclosureLabel(expanded: Bool, theme: AppTheme) -> AnyView? {
        AnyView(
            HStack(spacing: 8) {
                Text(expanded ? "▼" : "▶")
                    .font(.system(size: 7, weight: .bold))
                    .foregroundColor(amber)
                    .frame(width: 10)
                    .accessibilityHidden(true)
                Text("USAGE DETAILS")
                    .font(legendFont(8))
                    .tracking(1.6)
                    .foregroundColor(face)
                    .fixedSize()
                Pinstripe()
            }
        )
    }

    @MainActor static func footnote(_ text: String, theme: AppTheme) -> AnyView? {
        AnyView(
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text("NOTE")
                    .font(legendFont(7))
                    .tracking(1.2)
                    .foregroundColor(amber)
                Text(text)
                    .font(.system(size: 9.5))
                    .foregroundColor(legend)
                    .fixedSize(horizontal: false, vertical: true)
            }
        )
    }

    // MARK: - Hero

    struct Hero: View {
        let header: HeroHeader
        /// Observed directly so the deck redraws on every poll.
        @ObservedObject var loader: TokmeterLoader

        init(header: HeroHeader) {
            self.header = header
            self.loader = header.loader
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .center, spacing: 8) {
                    Text("TOKMETER")
                        .font(.system(size: 12, weight: .semibold).width(.expanded))
                        .tracking(2.4)
                        .foregroundColor(face)
                        .accessibilityAddTraits(.isHeader)
                    Text(deckModel)
                        .font(legendFont())
                        .tracking(1.4)
                        .foregroundColor(legend)
                        .lineLimit(1)
                        .layoutPriority(-1)
                    Spacer(minLength: 4)
                    header.cacheWalletToggle
                    lamps
                }
                .frame(minHeight: 22)

                VFDWindow {
                    display
                }
            }
            .padding(.horizontal, 16)
            .padding(.top, 10)
            .padding(.bottom, 12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Fascia())
        }

        /// Front-panel lamps: a red LIVE lamp lit only while the service is
        /// answering with fresh data; amber when stale or tuning in. A live
        /// session's project and age ride beside it.
        @ViewBuilder
        private var lamps: some View {
            // Same truth as the footer lamp: LIVE needs the phase AND a
            // daemon that answered; a held-over reading never counts.
            let alive = loader.daemonPhase == .live && loader.isDaemonAlive
            let stale = alive && loader.lastError != nil && loader.hasFreshData
            let live = alive && !stale
            HStack(spacing: 6) {
                if live, let session = loader.liveSession {
                    Text("\(Fmt.projectBasename(session.project)) · \(Fmt.liveAge(session.ageSeconds))".uppercased())
                        .font(vfdFont(9))
                        .foregroundColor(legend)
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .help("Live: \(session.provider) · \(Fmt.shortModel(session.model)) · last call \(Fmt.cost(session.lastRecordCost))")
                }
                if alive {
                    Lamp(text: stale ? "Stale" : "Live", color: stale ? amber : lampRed, lit: true)
                        .help(stale ? "Showing the last good reading; the latest refresh failed." : "Usage service is live.")
                } else if loader.daemonPhase == .warming {
                    Lamp(text: "Tuning", color: amber, lit: true)
                } else {
                    Lamp(text: "Offline", color: lampRed, lit: false)
                        .help(loader.daemonPhase == .needsNode ? "Node.js is required." : "Usage service offline.")
                }
            }
            .layoutPriority(1)
        }

        /// "Token deck · TD-284": the model number is the days recorded.
        private var deckModel: String {
            let days = loader.allDaily.count
            return days > 0 ? "TOKEN DECK · TD-\(days)" : "TOKEN DECK"
        }

        @ViewBuilder
        private var display: some View {
            switch loader.daemonPhase {
            case .warming:
                VStack(alignment: .leading, spacing: 8) {
                    LampLegend(text: "Tuning in")
                    header.skeletonHero
                }
            case .offline, .needsNode:
                VStack(alignment: .leading, spacing: 6) {
                    LampLegend(text: "No signal", color: legend)
                    header.offlineHero
                }
            case .live:
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        LampLegend(text: "Today · tokens")
                        Spacer()
                        LampLegend(text: "Est. API $")
                    }
                    HStack(alignment: .lastTextBaseline) {
                        VFDText(Fmt.number(loader.todayTokens), size: 40)
                            .accessibilityLabel("Tokens today: \(Fmt.number(loader.todayTokens))")
                        Spacer(minLength: 8)
                        VFDText(header.estimatedCostText.replacingOccurrences(of: "$", with: ""),
                                size: 28, color: amber)
                            .help("Usage valued at model API rates. Tool-reported costs are listed separately.")
                            .accessibilityLabel("Estimated API cost today: \(header.estimatedCostText)")
                    }
                    readoutStrip
                }
            }
        }

        /// The small line under the big digits: burn, block, tool-reported
        /// cost, and any honesty notes about the cost basis.
        @ViewBuilder
        private var readoutStrip: some View {
            let signals = loader.statbarSignals
            let parts: [(String, Color)] = {
                var out: [(String, Color)] = []
                if let burn = signals?.burnRate, burn.recordsInWindow > 0 {
                    out.append(("BURN \(Fmt.costPerHour(burn.costPerHour).uppercased())", cyan))
                }
                if let billing = signals?.billingWindow {
                    out.append(("BLOCK \(clock(billing.remainingSec)) LEFT", cyan))
                }
                if let basis = signals?.costBasisToday, basis.reportedRecords > 0 {
                    out.append(("TOOL \(Fmt.cost(basis.reportedCost))", cyan.opacity(0.7)))
                }
                return out
            }()
            VStack(alignment: .leading, spacing: 3) {
                if !parts.isEmpty {
                    HStack(spacing: 12) {
                        ForEach(parts, id: \.0) { part in
                            Text(part.0)
                                .font(vfdFont(10.5))
                                .foregroundColor(part.1)
                                .shadow(color: cyan.opacity(0.45), radius: 3)
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                        }
                    }
                }
                if let basis = signals?.costBasisToday {
                    if basis.unavailableRecords > 0 {
                        Text("COST UNAVAILABLE FOR SOME USAGE")
                            .font(vfdFont(10))
                            .foregroundColor(header.theme.statusWarning)
                    } else if basis.estimatedRecords + basis.reportedRecords == 0 {
                        Text("NO USAGE RECORDED TODAY")
                            .font(vfdFont(10))
                            .foregroundColor(legend)
                    }
                }
            }
            .help("API estimates value usage at model rates. Tool-reported costs come from local usage records. Neither is a verified subscription bill.")
        }

        /// "4:57" for the block countdown, like a deck's tape counter.
        private func clock(_ seconds: Int) -> String {
            String(format: "%d:%02d", seconds / 3600, (seconds % 3600) / 60)
        }
    }

    // MARK: - Signals

    struct Signals: View {
        let items: [SignalsRibbon.Item]
        let theme: AppTheme

        /// Percent readings become level meters. Burn and block time aren't
        /// ratios; they're already on the hero's readout strip.
        private var meters: [Meter] {
            var out: [Meter] = []
            for item in items {
                guard let pct = Self.percent(item.value) else { continue }
                switch item.id {
                case "cache":
                    out.append(Meter(id: "hit", label: "HIT", pct: pct, color: item.alert, help: item.help,
                                     spoken: "Cache hit \(Int(pct))%"))
                    if let sub = item.sub, let miss = Self.percent(sub.components(separatedBy: " ").first ?? "") {
                        out.append(Meter(id: "miss", label: "MISS", pct: miss, color: item.alert, help: item.help,
                                         spoken: "Cache miss \(Int(miss))%"))
                    }
                case "drag":
                    out.append(Meter(id: "drag", label: "GROWTH", pct: pct, color: item.alert, help: item.help,
                                     spoken: "Context growth \(Int(pct))%"))
                case "think":
                    out.append(Meter(id: "think", label: "THINK", pct: pct, color: item.alert, help: item.help,
                                     spoken: "Thinking \(Int(pct))% of output"))
                case "compact":
                    out.append(Meter(id: "comp", label: "COMPACT", pct: pct, color: item.alert, help: item.help,
                                     spoken: "Compaction \(Int(pct))% of spend"))
                default:
                    out.append(Meter(id: item.id, label: item.label.uppercased(), pct: pct, color: item.alert,
                                     help: item.help, spoken: "\(item.label) \(Int(pct))%"))
                }
            }
            return out
        }

        var body: some View {
            VFDWindow {
                VStack(alignment: .leading, spacing: 7) {
                    LampLegend(text: "Signal · today")
                    ForEach(meters) { meter in
                        HStack(spacing: 8) {
                            Text(meter.label)
                                .font(vfdFont(10))
                                .tracking(0.8)
                                .foregroundColor(amber)
                                .frame(width: 66, alignment: .leading)
                            SegmentMeter(fraction: meter.pct / 100, lit: meter.color ?? cyan)
                                .frame(height: 8)
                            Text("\(Int(meter.pct.rounded()))%")
                                .font(vfdFont(12))
                                .foregroundColor(meter.color ?? cyan)
                                .shadow(color: (meter.color ?? cyan).opacity(0.5), radius: 3)
                                .frame(width: 38, alignment: .trailing)
                        }
                        .help(meter.help)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel(meter.spoken)
                    }
                }
            }
        }

        private struct Meter: Identifiable {
            let id: String
            let label: String
            let pct: Double
            let color: Color?
            let help: String
            let spoken: String
        }

        static func percent(_ s: String) -> Double? {
            guard s.hasSuffix("%") else { return nil }
            return Double(s.dropLast())
        }
    }

    // MARK: - Ledger

    struct Ledger: View {
        let rows: [LedgerRowData]
        let theme: AppTheme

        var body: some View {
            VFDWindow {
                HStack(alignment: .top, spacing: 12) {
                    VStack(alignment: .leading, spacing: 5) {
                        LampLegend(text: "Counter · all time")
                        ForEach(rows) { row in
                            counterRow(row)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    // Tokens per day: the cost per day is already the chart below.
                    if let tokens = rows.first(where: { $0.id == "tokens" }), tokens.spark.count > 1 {
                        VStack(alignment: .leading, spacing: 5) {
                            LampLegend(text: "Spectrum · tok/day")
                            Spectrum(values: tokens.spark, days: tokens.sparkDays, theme: theme)
                        }
                        .frame(width: 150)
                    }
                }
            }
        }

        private func counterRow(_ row: LedgerRowData) -> some View {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(row.name.uppercased())
                    .font(legendFont(7.5))
                    .tracking(1.2)
                    .foregroundColor(legend)
                    .lineLimit(1)
                    .fixedSize()
                    .frame(minWidth: 40, alignment: .leading)
                if row.isWarming {
                    ShimmerBar(width: 48, height: 12, breathToggle: true)
                } else {
                    Text(row.value)
                        .font(vfdFont(16))
                        .foregroundColor(row.alert ?? (row.id == "cost" ? amber : cyan))
                        .shadow(color: (row.alert ?? cyan).opacity(0.45), radius: 3)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                        .contentTransition(.numericText())
                }
                Spacer(minLength: 2)
                if let trend = row.trend, !row.isWarming {
                    let up = trend.percent >= 0
                    Text("\(up ? "▲" : "▼")\(String(format: "%.1f", abs(trend.percent)))")
                        .font(vfdFont(10))
                        .foregroundColor(trend.metric == .cost && up ? theme.statusWarning : legend)
                        .lineLimit(1)
                        .help(trend.description)
                        .accessibilityLabel(trend.description)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    /// Seven-band analyser: tokens per settled day, chopped into VFD
    /// segments, with an amber peak-hold cap over the biggest day.
    struct Spectrum: View {
        let values: [Double]
        let days: [DailyUsage]
        let theme: AppTheme

        var body: some View {
            let shown = Array(values.suffix(7))
            let shownDays = Array(days.suffix(7))
            let peak = shown.max() ?? 0
            VStack(spacing: 3) {
                GeometryReader { geo in
                    let gap: CGFloat = 4
                    let w = max(1, (geo.size.width - gap * CGFloat(shown.count - 1)) / CGFloat(max(shown.count, 1)))
                    let h = geo.size.height
                    let segment: CGFloat = 3, segGap: CGFloat = 1.5
                    let rows = Int(h / (segment + segGap))
                    HStack(alignment: .bottom, spacing: gap) {
                        ForEach(Array(shown.enumerated()), id: \.offset) { i, v in
                            let lit = peak > 0 ? Int((v / peak * Double(rows - 2)).rounded()) : 0
                            VStack(spacing: segGap) {
                                ForEach(0..<rows, id: \.self) { r in
                                    let level = rows - 1 - r
                                    let isCap = v == peak && peak > 0 && level == lit + 1
                                    Rectangle()
                                        .fill(isCap ? amber : (level < lit ? cyan : cyan.opacity(0.08)))
                                        .frame(width: w, height: segment)
                                }
                            }
                            .shadow(color: cyan.opacity(0.35), radius: 2)
                            .accessibilityHidden(true)
                            .id(i)
                        }
                    }
                }
                .frame(height: 52)
                .modifier(SparklineUsageHover(days: shownDays, theme: theme))
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(spokenSummary(shown, shownDays))
                HStack(spacing: 4) {
                    ForEach(Array(shownDays.enumerated()), id: \.offset) { _, d in
                        Text(weekday(d.date))
                            .font(vfdFont(8.5))
                            .foregroundColor(legend)
                            .frame(maxWidth: .infinity)
                    }
                }
                .accessibilityHidden(true)
            }
        }

        private func weekday(_ ymd: String) -> String {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "yyyy-MM-dd"
            guard let date = f.date(from: ymd) else { return String(ymd.suffix(2)) }
            f.dateFormat = "EE"
            return String(f.string(from: date).prefix(2)).uppercased()
        }

        private func spokenSummary(_ values: [Double], _ days: [DailyUsage]) -> String {
            let parts = zip(days, values).map { "\($0.date): \(Fmt.number(Int($1))) tokens" }
            return "Daily tokens, last \(values.count) recorded days. " + parts.joined(separator: ", ")
        }
    }

    // MARK: - Section head

    struct SectionHead: View {
        let label: String
        let count: Int
        let theme: AppTheme

        var body: some View {
            HStack(spacing: 8) {
                Text(label.replacingOccurrences(of: "’", with: "'"))
                    .font(legendFont(8))
                    .tracking(1.3)
                    .foregroundColor(legend)
                    .lineLimit(1)
                    .fixedSize()
                if count > 0 {
                    Text(String(format: "%02d", count))
                        .font(vfdFont(11))
                        .foregroundColor(cyan)
                        .shadow(color: cyan.opacity(0.5), radius: 3)
                }
                Pinstripe()
            }
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Model row

    /// The model on a tuner scale: the pointer sits at its share of the
    /// costliest model's spend.
    struct ModelRow: View {
        let row: ModelRowData
        let theme: AppTheme

        var body: some View {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.name)
                        .font(vfdFont(11))
                        .foregroundColor(face)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let provider = row.provider {
                        Text(provider.uppercased())
                            .font(legendFont(6.5))
                            .tracking(1)
                            .foregroundColor(legend)
                            .lineLimit(1)
                    }
                }
                .frame(width: 104, alignment: .leading)
                TunerScale(share: row.activityOnly ? nil : row.share)
                    .frame(height: 18)
                    .help(row.help)
                Text(row.activityOnly ? "n/a" : Fmt.money(row.model.cost))
                    .font(vfdFont(11.5))
                    .foregroundColor(row.activityOnly ? legend : amber)
                    .frame(width: 58, alignment: .trailing)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.activityOnly
                ? "\(row.name): cost unavailable"
                : "\(row.name): \(Fmt.money(row.model.cost)), \(Int((row.share * 100).rounded()))% of the top model")
        }
    }

    struct TunerScale: View {
        /// 0…1, or nil for no priceable usage (no pointer).
        let share: Double?

        var body: some View {
            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height
                ZStack(alignment: .topLeading) {
                    RoundedRectangle(cornerRadius: 2).fill(window)
                    Path { p in
                        for i in 0...10 {
                            let x = 3 + (w - 6) * CGFloat(i) / 10
                            p.move(to: CGPoint(x: x, y: h - 2))
                            p.addLine(to: CGPoint(x: x, y: h - (i % 5 == 0 ? 8 : 5)))
                        }
                    }
                    .stroke(legend.opacity(0.7), lineWidth: 0.75)
                    if let share {
                        let x = 3 + (w - 6) * CGFloat(min(max(share, 0), 1))
                        Rectangle()
                            .fill(cyan)
                            .frame(width: 2, height: h - 3)
                            .shadow(color: cyan.opacity(0.8), radius: 3)
                            .offset(x: x - 1, y: 1.5)
                    }
                }
            }
            .accessibilityHidden(true)
        }
    }

    // MARK: - Project row

    struct ProjectRow: View {
        let project: ProjectData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Fmt.projectBasename(project.project))
                        .font(.system(size: 12.5, weight: .medium))
                        .foregroundColor(face)
                        .lineLimit(1)
                        .help(project.project)
                    Spacer(minLength: 6)
                    Text(Fmt.number(project.totalTokens))
                        .font(vfdFont(11))
                        .foregroundColor(cyan)
                        .shadow(color: cyan.opacity(0.4), radius: 2)
                    Text(Fmt.money(project.totalCost))
                        .font(vfdFont(12))
                        .foregroundColor(amber)
                        .frame(minWidth: 54, alignment: .trailing)
            }
            // The chrome line sits on the row's lower edge (the shared row
            // pads 6pt below), not as its own stacked line.
            .overlay(alignment: .bottom) { Pinstripe().offset(y: 6) }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(Fmt.projectBasename(project.project)): \(Fmt.number(project.totalTokens)) tokens today, \(Fmt.money(project.totalCost))")
        }
    }

    // MARK: - Card

    /// A smoked VFD window set into the fascia.
    struct Card: View {
        let role: Color
        var body: some View { WindowShape() }
    }

    // MARK: - Pieces

    /// Recessed smoked glass: near-black teal, an inner top shadow, a chrome
    /// lip catching light along the bottom edge.
    struct WindowShape: View {
        var body: some View {
            RoundedRectangle(cornerRadius: DeckSkin.cornerRadius)
                .fill(window)
                .overlay(
                    RoundedRectangle(cornerRadius: DeckSkin.cornerRadius)
                        .fill(LinearGradient(colors: [Color.black.opacity(0.75), .clear],
                                             startPoint: .top, endPoint: .init(x: 0.5, y: 0.22)))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: DeckSkin.cornerRadius)
                        .strokeBorder(Color.black, lineWidth: 1)
                )
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Color.white.opacity(0.09)).frame(height: 1).offset(y: 1)
                }
        }
    }

    struct VFDWindow<Content: View>: View {
        @ViewBuilder let content: Content
        var body: some View {
            content
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(WindowShape())
        }
    }

    /// Cyan VFD digits over their unlit "8" ghosts.
    struct VFDText: View {
        let text: String
        let size: CGFloat
        var color: Color = cyan

        init(_ text: String, size: CGFloat, color: Color = cyan) {
            self.text = text
            self.size = size
            self.color = color
        }

        private var ghost: String {
            String(text.map { $0.isNumber ? "8" : $0 })
        }

        var body: some View {
            ZStack(alignment: .trailing) {
                Text(ghost)
                    .foregroundColor(color.opacity(0.08))
                    .accessibilityHidden(true)
                Text(text)
                    .foregroundColor(color)
                    .shadow(color: color.opacity(0.55), radius: 4)
                    .contentTransition(.numericText())
            }
            .font(vfdFont(size))
            .lineLimit(1)
            .fixedSize()
        }
    }

    /// A panel lamp: a glowing dot and its legend; unlit is a dark dot.
    struct Lamp: View {
        let text: String
        let color: Color
        let lit: Bool
        var body: some View {
            HStack(spacing: 4) {
                Circle()
                    .fill(lit ? color : Color.white.opacity(0.10))
                    .frame(width: 6, height: 6)
                    .shadow(color: lit ? color.opacity(0.8) : .clear, radius: 3)
                Text(text.uppercased())
                    .font(vfdFont(10))
                    .tracking(1)
                    .foregroundColor(lit ? color : legend)
                    .lineLimit(1)
                    .fixedSize()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(text)\(lit ? "" : ", off")")
        }
    }

    /// Amber lamp legend inside a window.
    struct LampLegend: View {
        let text: String
        var color: Color = amber
        var body: some View {
            Text(text.uppercased())
                .font(vfdFont(9.5))
                .tracking(1)
                .foregroundColor(color)
                .shadow(color: color.opacity(0.4), radius: 2)
                .lineLimit(1)
        }
    }

    /// Twenty-segment level meter, lit from the left.
    struct SegmentMeter: View {
        let fraction: Double
        let lit: Color

        var body: some View {
            GeometryReader { geo in
                let count = 20
                let gap: CGFloat = 2
                let w = (geo.size.width - gap * CGFloat(count - 1)) / CGFloat(count)
                let on = Int((min(max(fraction, 0), 1) * Double(count)).rounded())
                HStack(spacing: gap) {
                    ForEach(0..<count, id: \.self) { i in
                        Rectangle()
                            .fill(i < on ? lit : lit.opacity(0.10))
                            .frame(width: max(w, 1))
                            .shadow(color: i < on ? lit.opacity(0.6) : .clear, radius: 2)
                    }
                }
            }
            .accessibilityHidden(true)
        }
    }

    /// Chrome pinstripe, bright in the middle, fading to the ends.
    struct Pinstripe: View {
        var body: some View {
            LinearGradient(colors: [.clear, Color(red: 0.55, green: 0.57, blue: 0.59), .clear],
                           startPoint: .leading, endPoint: .trailing)
                .frame(height: 1)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
        }
    }

    /// Brushed-metal fascia behind the hero: a lit top edge and fine
    /// horizontal brushing.
    struct Fascia: View {
        var body: some View {
            ZStack {
                LinearGradient(colors: [Color(red: 0.135, green: 0.139, blue: 0.146), surface],
                               startPoint: .top, endPoint: .bottom)
                Canvas { ctx, size in
                    var y: CGFloat = 0
                    var i = 0
                    while y < size.height {
                        let alpha = i % 3 == 0 ? 0.035 : 0.018
                        ctx.fill(Path(CGRect(x: 0, y: y, width: size.width, height: 0.5)),
                                 with: .color(.white.opacity(alpha)))
                        y += 1.5
                        i += 1
                    }
                }
                VStack {
                    Rectangle().fill(Color.white.opacity(0.12)).frame(height: 1)
                    Spacer()
                    Rectangle().fill(Color.black.opacity(0.6)).frame(height: 1)
                }
            }
            .accessibilityHidden(true)
        }
    }
}

extension DeckSkin {
    /// Soft-touch transport keys: the pressed key sits lower and darker with
    /// a cyan lamp above its legend.
    struct TransportTabs: View {
        @Binding var showToday: Bool

        var body: some View {
            HStack(spacing: 4) {
                key("All", on: !showToday) { showToday = false }
                key("Today", on: showToday) { showToday = true }
            }
        }

        private func key(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
            Button(action: action) {
                VStack(spacing: 2) {
                    Rectangle()
                        .fill(on ? cyan : Color.white.opacity(0.10))
                        .frame(width: 12, height: 2)
                        .shadow(color: on ? cyan.opacity(0.8) : .clear, radius: 2)
                    Text(label.uppercased())
                        .font(legendFont(7))
                        .tracking(1)
                        .foregroundColor(on ? face : legend)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 3)
                        .fill(LinearGradient(
                            colors: on
                                ? [Color(red: 0.10, green: 0.105, blue: 0.11), Color(red: 0.14, green: 0.145, blue: 0.15)]
                                : [Color(red: 0.24, green: 0.245, blue: 0.255), Color(red: 0.15, green: 0.155, blue: 0.16)],
                            startPoint: .top, endPoint: .bottom))
                )
                .overlay(RoundedRectangle(cornerRadius: 3).strokeBorder(Color.black, lineWidth: 1))
                .offset(y: on ? 1 : 0)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
            .accessibilityAddTraits(on ? .isSelected : [])
        }
    }

    /// The 7-day cost chart as a segmented VFD analyser. Today (when it's in
    /// the series) is lit in amber and labelled with its running cost.
    struct CostSpectrum: View {
        let days: [DailyUsage]
        let theme: AppTheme
        @State private var hovered: DailyUsage?

        /// Local yyyy-MM-dd. The last recorded day is only "today" when its
        /// date says so; after a quiet day it's simply the latest entry.
        private var todayKey: String { LocalDay.todayKey() }

        var body: some View {
            let peak = max(days.map(\.cost).max() ?? 0, 0.0001)
            let todayKey = todayKey
            VFDWindow {
                VStack(spacing: 4) {
                    HStack {
                        LampLegend(text: "Spectrum · $/day")
                        Spacer()
                        if let today = days.last(where: { $0.date == todayKey }) {
                            Text("TODAY \(Fmt.cost(today.cost)) SO FAR")
                                .font(vfdFont(10))
                                .foregroundColor(amber)
                                .shadow(color: amber.opacity(0.45), radius: 2)
                        }
                    }
                    GeometryReader { geo in
                        let gap: CGFloat = 6
                        let n = max(days.count, 1)
                        let w = max(1, (geo.size.width - gap * CGFloat(n - 1)) / CGFloat(n))
                        let segment: CGFloat = 3, segGap: CGFloat = 1.5
                        let rows = max(Int(geo.size.height / (segment + segGap)), 2)
                        HStack(alignment: .bottom, spacing: gap) {
                            ForEach(Array(days.enumerated()), id: \.offset) { i, day in
                                let isToday = day.date == todayKey
                                let lit = day.cost > 0 ? max(1, Int((day.cost / peak * Double(rows)).rounded())) : 0
                                let ink = isToday ? amber : cyan
                                VStack(spacing: segGap) {
                                    ForEach(0..<rows, id: \.self) { r in
                                        Rectangle()
                                            .fill(rows - 1 - r < lit ? ink : ink.opacity(0.08))
                                            .frame(width: w, height: segment)
                                    }
                                }
                                .shadow(color: ink.opacity(0.35), radius: 2)
                                .opacity(hovered == nil || hovered?.date == day.date ? 1 : 0.55)
                            }
                        }
                        .contentShape(Rectangle())
                        .onContinuousHover { phase in
                            switch phase {
                            case .active(let p):
                                guard !days.isEmpty, geo.size.width > 0 else { hovered = nil; return }
                                let i = Int((p.x / geo.size.width * CGFloat(days.count)).rounded(.down))
                                hovered = days[min(max(i, 0), days.count - 1)]
                            case .ended: hovered = nil
                            }
                        }
                    }
                    .frame(height: 56)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(spoken)
                    HStack(spacing: 6) {
                        ForEach(Array(days.enumerated()), id: \.offset) { i, day in
                            Text(String(day.date.suffix(5)))
                                .font(vfdFont(8))
                                .foregroundColor(day.date == todayKey ? amber : legend)
                                .lineLimit(1)
                                .minimumScaleFactor(0.7)
                                .frame(maxWidth: .infinity)
                        }
                    }
                    .accessibilityHidden(true)
                }
            }
            .overlay(alignment: .top) {
                if let hovered {
                    DailyUsageTooltip(day: hovered, theme: theme).offset(y: -30)
                }
            }
        }

        private var spoken: String {
            let parts = days.map { "\($0.date): \(Fmt.cost($0.cost))" }
            let counting = days.contains { $0.date == todayKey } ? ", today still counting" : ""
            return "Daily cost, last \(days.count) recorded days\(counting). "
                + parts.joined(separator: ", ")
        }
    }
}
