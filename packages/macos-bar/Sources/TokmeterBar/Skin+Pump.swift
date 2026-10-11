// Skin+Pump.swift — the "Pump" skin: a forecourt fuel-pump computer.
//
// The pump answers the two questions a meter should: what did today cost,
// and at what rate. The front window carries SALE (today's estimated API
// cost), TOKENS (today's volume) and EST. PAID $ PER M (today's cost, estimate
// plus tool-reported, ÷ today's tokens — the same definition as the Rates
// panel's "Est. paid today", an average across models, never a list price).
// Models are grade plates filled to their cost share, the readings sit on
// enamel plates, projects are fill-ups, and the all-time totals live on the
// non-resettable totalizer. Enamel green housing, cream plates, amber for
// money and for anything that needs a look.

import SwiftUI

enum PumpSkin: SkinSpec {
    static let displayName = "Pump"
    static let tagline = "Forecourt pump computer"
    static let icon = "fuelpump.fill"

    // Housing, plate and ink. The housing is dark enough that the shared
    // secondary text (white at 55%) still clears 4.5:1 on it.
    static let housing = Color(red: 0.090, green: 0.239, blue: 0.184)     // #173D2F
    static let housingDeep = Color(red: 0.055, green: 0.165, blue: 0.125) // #0E2A20
    static let cream = Color(red: 0.965, green: 0.953, blue: 0.918)       // #F6F3EA
    static let creamDim = Color(red: 0.812, green: 0.890, blue: 0.847)    // #CFE3D8
    static let ink = Color(red: 0.055, green: 0.165, blue: 0.125)         // plate ink = deep green
    static let inkMuted = Color(red: 0.227, green: 0.310, blue: 0.275)    // #3A4F46, 7:1 on cream
    static let amber = Color(red: 1.0, green: 0.820, blue: 0.400)         // #FFD166
    static let lampGreen = Color(red: 0.494, green: 0.878, blue: 0.541)   // #7EE08A
    static let lampRed = Color(red: 0.910, green: 0.322, blue: 0.290)     // #E8524A
    static let alertInk = Color(red: 0.55, green: 0.10, blue: 0.06)       // on cream / amber
    /// Pale amber for the grade plates' cost-share fill; full amber stays
    /// reserved for money and flagged readings.
    static let gradeFill = Color(red: 0.976, green: 0.890, blue: 0.651)   // #F9E3A6

    static let surface = housing
    static let isLight = false
    static var gradient: [Color] { [housing, housing] }
    static let palette = ThemeColors(
        primary: housingDeep, secondary: cream, accent: amber,
        highlight: amber, warm: creamDim, tertiary: lampGreen)
    static let fonts = ThemeFonts(heroDesign: .monospaced, heroWeight: .medium,
                                  valueDesign: .monospaced, valueWeight: .medium,
                                  labelDesign: .default, bodyDesign: .default)
    static var costInk: Color { amber }
    static let cornerRadius: CGFloat = 6

    @MainActor static func weekChart(days: [DailyUsage], style: WeekChartStyle, theme: AppTheme) -> AnyView? {
        AnyView(HoseMeter(days: days, theme: theme))
    }

    @MainActor static func modelTabs(showToday: Binding<Bool>, theme: AppTheme) -> AnyView? {
        AnyView(GradeTabs(showToday: showToday))
    }

    @MainActor static func disclosureLabel(expanded: Bool, theme: AppTheme) -> AnyView? {
        AnyView(
            HStack(spacing: 8) {
                Text(expanded ? "▾" : "▸")
                    .font(.system(size: 11, weight: .heavy))
                    .foregroundColor(amber)
                    .frame(width: 10)
                    .accessibilityHidden(true)
                Text("USAGE DETAILS")
                    .font(plateFont(12.5))
                    .tracking(1.5)
                    .foregroundColor(cream)
                ChromeStrip().frame(maxWidth: .infinity)
            }
        )
    }

    @MainActor static func footnote(_ text: String, theme: AppTheme) -> AnyView? {
        AnyView(
            Text(text.uppercased())
                .font(plateFont(10.5))
                .tracking(1.0)
                .foregroundColor(creamDim)
                .fixedSize(horizontal: false, vertical: true)
        )
    }

    /// Compressed heavy capitals — the stencilled lettering on the housing.
    static func plateFont(_ size: CGFloat) -> Font {
        .system(size: size, weight: .heavy).width(.compressed)
    }

    static func monoFont(_ size: CGFloat, weight: Font.Weight = .medium) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    // MARK: Hero — the pump computer

    struct Hero: View {
        let header: HeroHeader
        /// Observed directly so the window redraws on every poll.
        @ObservedObject private var loader: TokmeterLoader
        @Environment(\.accessibilityReduceMotion) private var reduceMotion

        init(header: HeroHeader) {
            self.header = header
            _loader = ObservedObject(wrappedValue: header.loader)
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                headRow
                ChromeStrip()
                window
                reportedLine
            }
            .padding(.horizontal, 16)
            .padding(.top, 12)
            .padding(.bottom, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(housing)
        }

        private var headRow: some View {
            HStack(alignment: .center, spacing: 10) {
                Text("TM")
                    .font(.system(size: 14, weight: .black).width(.compressed))
                    .foregroundColor(housing)
                    .frame(width: 34, height: 34)
                    .background(Circle().fill(cream))
                    .overlay(Circle().strokeBorder(amber, lineWidth: 2.5).padding(1))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 0) {
                    Text("TOKMETER")
                        .font(plateFont(22))
                        .tracking(1.6)
                        .foregroundColor(cream)
                        .accessibilityAddTraits(.isHeader)
                    Text(dateLine)
                        .font(plateFont(11))
                        .tracking(1.4)
                        .foregroundColor(creamDim)
                }
                Spacer(minLength: 6)
                header.cacheWalletToggle
                PumpLamp(state: lampState, detail: lampDetail)
            }
        }

        private var dateLine: String {
            let f = DateFormatter()
            f.locale = Locale(identifier: "en_US_POSIX")
            f.dateFormat = "EEE d MMM"
            return "PUMP · " + f.string(from: Date()).uppercased()
        }

        private var lampState: PumpLamp.State {
            switch loader.daemonPhase {
            case .warming: return .priming
            case .offline, .needsNode: return .outOfService
            case .live:
                if loader.lastError != nil && loader.hasFreshData { return .stale }
                return loader.liveSession != nil ? .pumping : .ready
            }
        }

        private var lampDetail: String {
            switch lampState {
            case .pumping:
                if let live = loader.liveSession {
                    return "Live: \(live.provider) · \(Fmt.shortModel(live.model)) in \(Fmt.projectBasename(live.project)) · last call \(Fmt.cost(live.lastRecordCost)), \(Fmt.liveAge(live.ageSeconds)) ago"
                }
                return "A session is running now."
            case .ready: return "Usage service connected. No session running right now."
            case .stale: return "Showing the last good reading; the latest refresh failed."
            case .priming: return "The usage service is starting."
            case .outOfService:
                return loader.daemonPhase == .needsNode
                    ? "Node.js 18+ is required to run the local usage service."
                    : "The usage service is offline. Press ▶ Start below."
            }
        }

        // The cream window with SALE / TOKENS / BLENDED $ PER M.
        @ViewBuilder
        private var window: some View {
            VStack(spacing: 0) {
                switch loader.daemonPhase {
                case .live:
                    windowRow(label: "Sale", size: 20, wheels: header.estimatedCostText, wheelSize: .large,
                              note: "est. API cost today",
                              help: "Today's usage valued at model API rates. Tool-reported costs are listed below the window.",
                              a11y: "Sale, estimated API cost today: \(header.estimatedCostText)")
                    plateRule
                    windowRow(label: "Tokens", size: 16, wheels: Fmt.number(loader.todayTokens), wheelSize: .large,
                              note: "today",
                              help: "Tokens recorded today across every tool.",
                              a11y: "Tokens today: \(Fmt.number(loader.todayTokens))")
                    plateRule
                    windowRow(label: "Est. paid $ per M", size: 13, wheels: rateText, wheelSize: .small,
                              note: "today's cost ÷ today's tokens · not a list price",
                              help: rateHelp,
                              a11y: "Estimated paid per million tokens today: \(rateText)")
                case .warming:
                    dashRow("Sale"); plateRule; dashRow("Tokens")
                    Text("Priming — reading today's sessions…")
                        .font(monoFont(10)).foregroundColor(inkMuted)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 6)
                case .offline, .needsNode:
                    dashRow("Sale"); plateRule; dashRow("Tokens")
                    VStack(alignment: .leading, spacing: 2) {
                        Text(loader.daemonPhase == .needsNode ? "OUT OF SERVICE · NODE.JS REQUIRED" : "OUT OF SERVICE")
                            .font(plateFont(13)).tracking(1.2).foregroundColor(alertInk)
                        Text(loader.daemonPhase == .needsNode
                             ? "Install Node 18+ to run the local service."
                             : "No live numbers — press ▶ Start below.")
                            .font(monoFont(10)).foregroundColor(inkMuted)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 6)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 6)
                    .fill(Color(red: 0.984, green: 0.980, blue: 0.965))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(housingDeep, lineWidth: 2)
                    )
                    .overlay(alignment: .top) {
                        // Recessed glass: a soft shadow under the top edge.
                        LinearGradient(colors: [Color.black.opacity(0.18), .clear],
                                       startPoint: .top, endPoint: .bottom)
                            .frame(height: 6)
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                            .padding(2)
                    }
            )
        }

        private var plateRule: some View {
            Rectangle().fill(ink.opacity(0.3)).frame(height: 1).padding(.vertical, 5)
        }

        private func windowRow(label: String, size: CGFloat, wheels: String, wheelSize: PumpWheels.Size,
                               note: String, help: String, a11y: String) -> some View {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(label.uppercased())
                        .font(plateFont(size))
                        .tracking(1.4)
                        .foregroundColor(ink)
                        .lineLimit(1)
                    Text(note)
                        .font(monoFont(9, weight: .regular))
                        .foregroundColor(inkMuted)
                        .lineLimit(1)
                }
                .layoutPriority(1)
                Spacer(minLength: 4)
                PumpWheels(text: wheels, size: wheelSize, animate: !reduceMotion)
            }
            .help(help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(a11y)
        }

        private func dashRow(_ label: String) -> some View {
            HStack {
                Text(label.uppercased()).font(plateFont(16)).tracking(1.4).foregroundColor(ink)
                Spacer()
                PumpWheels(text: "– – . – –", size: .large, animate: false)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(label): no reading")
        }

        /// Today's cost (API estimate plus tool-reported) per million of
        /// today's tokens: numerator and denominator cover the same records,
        /// and it matches the Rates panel's "Est. paid today". "—" with no
        /// cost or no tokens.
        private var rateText: String {
            guard loader.todayCost > 0, loader.todayTokens > 0 else { return "—" }
            let rate = loader.todayCost / Double(loader.todayTokens) * 1_000_000
            return String(format: "$%.2f", rate)
        }

        private var rateHelp: String {
            var text = "Today's cost (API estimate plus tool-reported) ÷ today's tokens, per million. "
                + "It blends every model and cache read you used today — a measure of your mix, "
                + "not any model's list price. SALE above is the API estimate alone."
            if let basis = loader.statbarSignals?.costBasisToday, basis.unavailableRecords > 0 {
                text += " Some of today's usage has no cost, so this average reads low."
            }
            return text
        }

        @ViewBuilder
        private var reportedLine: some View {
            if loader.daemonPhase == .live, let basis = loader.statbarSignals?.costBasisToday {
                HStack(spacing: 8) {
                    if basis.reportedRecords > 0 {
                        Text("TOOL-REPORTED").font(plateFont(11)).tracking(1.2).foregroundColor(creamDim)
                        Text(Fmt.cost(basis.reportedCost)).font(monoFont(11)).foregroundColor(cream)
                    }
                    if basis.unavailableRecords > 0 {
                        Text("Cost unavailable for some usage")
                            .font(monoFont(10)).foregroundColor(amber)
                    } else if basis.estimatedRecords + basis.reportedRecords == 0 {
                        Text("No usage recorded today").font(monoFont(10)).foregroundColor(creamDim)
                    }
                    Spacer(minLength: 0)
                }
                .help("API estimates value usage at model rates. Tool-reported costs come from local usage records. Neither is a verified subscription bill.")
            }
        }
    }

    // MARK: Signals — enamel plates

    struct Signals: View {
        let items: [SignalsRibbon.Item]
        let theme: AppTheme

        var body: some View {
            LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 3), spacing: 6) {
                ForEach(items) { item in
                    plate(item)
                }
            }
        }

        private func label(for item: SignalsRibbon.Item) -> String {
            item.id == "burn" ? "Flow $ / hr" : item.label
        }

        private func plate(_ item: SignalsRibbon.Item) -> some View {
            let flagged = item.alert != nil
            return VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 3) {
                    if flagged {
                        Text("!").font(plateFont(11)).foregroundColor(alertInk)
                    }
                    Text(label(for: item).uppercased())
                        .font(plateFont(10.5))
                        .tracking(1.1)
                        .foregroundColor(ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                Text(item.value)
                    .font(monoFont(15))
                    .foregroundColor(flagged ? alertInk : ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .contentTransition(.numericText())
                if let elapsed = item.elapsed {
                    // The 5h block as a fuel-gauge strip: filled = used.
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(ink.opacity(0.15))
                            Rectangle().fill(flagged ? alertInk : ink)
                                .frame(width: safeDim(geo.size.width * CGFloat(elapsed)))
                        }
                    }
                    .frame(height: 3)
                    .padding(.vertical, 1)
                    .accessibilityHidden(true)
                }
                Text(item.sub ?? " ")
                    .font(monoFont(9, weight: .regular))
                    .foregroundColor(inkMuted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(
                RoundedRectangle(cornerRadius: 4)
                    .fill(flagged ? amber : cream)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(Color.black.opacity(0.15)).frame(height: 2)
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
            )
            .help(item.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(item.label): \(item.value)\(item.sub.map { ", " + $0 } ?? "")\(flagged ? ", needs attention" : "")")
        }
    }

    // MARK: Ledger — the totalizer

    struct Ledger: View {
        let rows: [LedgerRowData]
        let theme: AppTheme

        var body: some View {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Text("ALL-TIME TOTALS · NON-RESETTABLE")
                        .font(plateFont(11)).tracking(1.4).foregroundColor(creamDim)
                    Spacer()
                    Text("DAY CHANGE")
                        .font(plateFont(10)).tracking(1.2).foregroundColor(creamDim)
                }
                ForEach(rows) { row in
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 0) {
                            Text(row.name.uppercased())
                                .font(plateFont(13)).tracking(1.2).foregroundColor(cream)
                            Text(row.note).font(monoFont(9, weight: .regular)).foregroundColor(creamDim)
                        }
                        .frame(width: 84, alignment: .leading)
                        if row.isWarming {
                            ShimmerBar(width: 70, height: 18, breathToggle: true)
                        } else {
                            PumpWheels(text: row.value, size: .small, animate: true,
                                       alertInk: row.alert == nil ? nil : alertInk,
                                       glyphInk: row.alert == nil ? cream : amber)
                        }
                        Spacer(minLength: 4)
                        InlineSparkline(values: row.spark, color: creamDim, progress: 1, flat: true)
                            .frame(width: 54, height: 14)
                            .modifier(SparklineUsageHover(days: row.sparkDays, theme: theme))
                        change(row)
                            .frame(width: 52, alignment: .trailing)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 6).fill(housingDeep)
                    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.white.opacity(0.10), lineWidth: 1))
            )
        }

        @ViewBuilder
        private func change(_ row: LedgerRowData) -> some View {
            if let trend = row.trend, !row.isWarming {
                let up = trend.percent >= 0
                Text("\(up ? "▲" : "▼")\(String(format: "%.1f", abs(trend.percent)))%")
                    .font(monoFont(10))
                    .foregroundColor(trend.metric == .cost && up ? amber : cream)
                    .lineLimit(1)
                    .help(trend.description)
                    .accessibilityLabel(trend.description)
            } else if row.alert != nil, !row.isWarming {
                Text("HOT").font(plateFont(11)).tracking(1.2).foregroundColor(amber)
                    .help("Today is running well above your usual pace at this hour.")
            } else {
                Text("—").font(monoFont(10)).foregroundColor(creamDim).accessibilityHidden(true)
            }
        }
    }

    // MARK: Section head — stencil label + count tag + chrome strip

    struct SectionHead: View {
        let label: String
        let count: Int
        let theme: AppTheme

        /// Pump's name for each section, with the plain title kept after it
        /// ("GRADES · TODAY'S MODELS", "HOSE METER · LAST 30 RECORDED DAYS"),
        /// so the count and period are never lost behind the metaphor.
        private var pumpLabel: String {
            let upper = label.uppercased()
            if upper.contains("MODELS") {
                // The popover's models head shares its row with the $/M
                // button and the All/Today keys, which already say which
                // scope this is; keep the head short there so it fits.
                let scoped = upper.hasPrefix("TODAY") || upper.hasPrefix("TOP")
                return scoped ? "GRADES · MODELS" : "GRADES · \(upper)"
            }
            if upper.contains("PROJECTS") { return "FILL-UPS · \(upper)" }
            if upper.contains("RECORDED DAYS") { return "HOSE METER · \(upper)" }
            return label
        }

        var body: some View {
            HStack(spacing: 8) {
                Text(pumpLabel.uppercased())
                    .font(plateFont(12.5))
                    .tracking(1.5)
                    .foregroundColor(cream)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    // The title claims its room first; the chrome strip is
                    // the part that gives way.
                    .layoutPriority(2)
                if count > 0 {
                    Text("\(count)")
                        .font(monoFont(10, weight: .semibold))
                        .foregroundColor(housingDeep)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(RoundedRectangle(cornerRadius: 3).fill(amber))
                }
                ChromeStrip().frame(maxWidth: .infinity)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(label), \(count)")
            .accessibilityAddTraits(.isHeader)
        }
    }

    // MARK: Model row — a grade plate with a level gauge along its foot

    struct ModelRow: View {
        let row: ModelRowData
        let theme: AppTheme

        var body: some View {
            VStack(spacing: 4) {
                HStack(spacing: 8) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text(row.name)
                            .font(monoFont(12, weight: .semibold))
                            .foregroundColor(ink)
                            .lineLimit(1)
                            .truncationMode(.middle)
                        if let provider = row.provider {
                            Text(provider).font(monoFont(9, weight: .regular)).foregroundColor(inkMuted).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    Text(row.activityOnly ? "N/A" : Fmt.money(row.model.cost))
                        .font(row.activityOnly ? plateFont(12) : monoFont(13, weight: .semibold))
                        .foregroundColor(row.activityOnly ? inkMuted : ink)
                        .monospacedDigit()
                }
                // The share sits in its own strip under the text, so the
                // fill never runs through a glyph.
                GeometryReader { geo in
                    ZStack(alignment: .leading) {
                        Capsule().fill(housingDeep.opacity(0.16))
                        Capsule()
                            .fill(gradeFill)
                            .frame(width: safeDim(geo.size.width * CGFloat(row.share), floor: row.share > 0 ? 4 : 0))
                    }
                }
                .frame(height: 4)
            }
            .padding(.horizontal, 10)
            .padding(.top, 5)
            .padding(.bottom, 6)
            .background(RoundedRectangle(cornerRadius: 5).fill(cream))
            .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(housingDeep, lineWidth: 1.5))
            .animation(.spring(response: 0.6, dampingFraction: 0.8), value: row.share)
            .help(row.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.activityOnly
                ? "\(row.name): cost unavailable"
                : "\(row.name): \(Fmt.money(row.model.cost)), \(Int((row.share * 100).rounded()))% of the top model's cost")
        }
    }

    // MARK: Project row — a fill-up

    struct ProjectRow: View {
        let project: ProjectData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Fmt.projectBasename(project.project))
                    .font(.system(size: 16, weight: .bold).width(.condensed))
                    .foregroundColor(cream)
                    .lineLimit(1)
                    .help(project.project)
                Spacer(minLength: 6)
                Text("\(Fmt.number(project.totalTokens)) tok")
                    .font(monoFont(11, weight: .regular))
                    .foregroundColor(creamDim)
                Text(Fmt.money(project.totalCost))
                    .font(monoFont(12, weight: .semibold))
                    .foregroundColor(amber)
                    .frame(minWidth: 52, alignment: .trailing)
            }
            .padding(.bottom, 3)
            .overlay(alignment: .bottom) {
                Line()
                    .stroke(cream.opacity(0.35), style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
                    .frame(height: 1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(Fmt.projectBasename(project.project)): \(Fmt.number(project.totalTokens)) tokens, \(Fmt.money(project.totalCost)) today")
            // The shared row adds 6pt above and below for card-style themes;
            // a fill-up line is ruled, so take most of that back.
            .padding(.vertical, -4)
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

    // MARK: Card — a recessed panel in the housing

    struct Card: View {
        let role: Color
        var body: some View {
            RoundedRectangle(cornerRadius: PumpSkin.cornerRadius)
                .fill(housingDeep)
                .overlay(
                    RoundedRectangle(cornerRadius: PumpSkin.cornerRadius)
                        .strokeBorder(Color.white.opacity(0.10), lineWidth: 1)
                )
        }
    }
}

// MARK: - Pieces

/// The polished trim strip between housing panels.
private struct ChromeStrip: View {
    var body: some View {
        Capsule()
            .fill(LinearGradient(
                colors: [Color.white, Color(red: 0.655, green: 0.667, blue: 0.678), Color(red: 0.91, green: 0.914, blue: 0.918)],
                startPoint: .top, endPoint: .bottom))
            .frame(height: 3)
            .accessibilityHidden(true)
    }
}

/// Number wheels: each digit on its own drum (white face shading to grey at
/// the curve), punctuation and units printed between them. Digits roll with
/// a numeric transition when the reading changes.
struct PumpWheels: View {
    enum Size { case large, small }
    let text: String
    let size: Size
    var animate: Bool = true
    var alertInk: Color? = nil
    /// Colour of the printed units and punctuation between the drums.
    var glyphInk: Color = PumpSkin.ink

    private var cell: CGSize { size == .large ? CGSize(width: 20, height: 30) : CGSize(width: 14, height: 20) }
    private var digitFont: Font { .system(size: size == .large ? 22 : 14, weight: .medium, design: .monospaced) }
    private var glyphFont: Font { .system(size: size == .large ? 17 : 12, weight: .semibold, design: .monospaced) }

    var body: some View {
        HStack(spacing: size == .large ? 2.5 : 2) {
            ForEach(Array(text.enumerated()), id: \.offset) { _, ch in
                if ch.isNumber {
                    Text(String(ch))
                        .font(digitFont)
                        .foregroundColor(alertInk ?? Color(red: 0.067, green: 0.067, blue: 0.067))
                        .contentTransition(.numericText())
                        .animation(animate ? .spring(response: 0.5, dampingFraction: 0.85) : nil, value: text)
                        .frame(width: cell.width, height: cell.height)
                        .background(
                            LinearGradient(stops: [
                                .init(color: Color(red: 0.74, green: 0.73, blue: 0.70), location: 0),
                                .init(color: .white, location: 0.28),
                                .init(color: .white, location: 0.72),
                                .init(color: Color(red: 0.74, green: 0.73, blue: 0.70), location: 1),
                            ], startPoint: .top, endPoint: .bottom)
                        )
                        .overlay(Rectangle().strokeBorder(Color(red: 0.435, green: 0.424, blue: 0.392), lineWidth: 1))
                } else if ch == " " {
                    Spacer().frame(width: 2)
                } else {
                    Text(String(ch))
                        .font(glyphFont)
                        .foregroundColor(glyphInk)
                        .frame(height: cell.height, alignment: .bottom)
                        .padding(.bottom, size == .large ? 3 : 2)
                }
            }
        }
        .fixedSize()
        .accessibilityLabel(text)
    }
}

/// The pump's status lamp. Green while a session is pumping (steady glow
/// when ready), amber priming or stale, red out of service.
private struct PumpLamp: View {
    enum State { case pumping, ready, stale, priming, outOfService }
    let state: State
    let detail: String

    private var color: Color {
        switch state {
        case .pumping, .ready: return PumpSkin.lampGreen
        case .stale, .priming: return PumpSkin.amber
        case .outOfService: return PumpSkin.lampRed
        }
    }

    private var title: String {
        switch state {
        case .pumping: return "PUMPING"
        case .ready: return "READY"
        case .stale: return "STALE"
        case .priming: return "PRIMING"
        case .outOfService: return "OFF"
        }
    }

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(color)
                .frame(width: 9, height: 9)
                .shadow(color: state == .pumping ? color : .clear, radius: 4)
                .overlay(Circle().strokeBorder(Color.black.opacity(0.25), lineWidth: 0.5))
            Text(title)
                .font(PumpSkin.plateFont(12))
                .tracking(1.4)
                .foregroundColor(PumpSkin.cream)
        }
        .help(detail)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(title.capitalized). \(detail)")
    }
}

/// The hose meter: one bar per recorded day, cost as the length of hose
/// run out. Today's row is still accumulating, so it is set in amber and
/// marked "so far". Hover a row for date, cost and tokens.
private struct HoseMeter: View {
    let days: [DailyUsage]
    let theme: AppTheme
    @State private var hovered: String?

    private var maxCost: Double { max(days.map(\.cost).max() ?? 0, 0.01) }

    /// Local YYYY-MM-DD; only a row dated today is "so far".
    private var todayKey: String { LocalDay.todayKey() }

    private func dayLabel(_ date: String) -> String {
        let parse = DateFormatter()
        parse.locale = Locale(identifier: "en_US_POSIX")
        parse.dateFormat = "yyyy-MM-dd"
        guard let d = parse.date(from: date) else { return String(date.suffix(5)) }
        let out = DateFormatter()
        out.locale = Locale(identifier: "en_US_POSIX")
        out.dateFormat = "EEE"
        return out.string(from: d).uppercased()
    }

    var body: some View {
        VStack(spacing: 4) {
            ForEach(days, id: \.date) { day in
                let isToday = day.date == todayKey
                HStack(spacing: 8) {
                    Text(dayLabel(day.date))
                        .font(PumpSkin.plateFont(11))
                        .tracking(1.2)
                        .foregroundColor(isToday ? PumpSkin.amber : PumpSkin.creamDim)
                        .frame(width: 30, alignment: .leading)
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(Color.white.opacity(0.08))
                            Rectangle()
                                .fill(isToday ? PumpSkin.amber : PumpSkin.cream)
                                .frame(width: safeDim(geo.size.width * CGFloat(day.cost / maxCost), floor: day.cost > 0 ? 2 : 0))
                        }
                    }
                    .frame(height: 7)
                    Text(Fmt.cost(day.cost) + (isToday ? "*" : ""))
                        .font(PumpSkin.monoFont(10))
                        .foregroundColor(isToday ? PumpSkin.amber : PumpSkin.cream)
                        .frame(width: 58, alignment: .trailing)
                }
                .contentShape(Rectangle())
                .onHover { hovered = $0 ? day.date : (hovered == day.date ? nil : hovered) }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(day.date)\(isToday ? ", today so far" : ""): \(Fmt.cost(day.cost)), \(Fmt.number(day.tokens)) tokens")
            }
            if days.contains(where: { $0.date == todayKey }) {
                Text("* TODAY, SO FAR")
                    .font(PumpSkin.plateFont(9.5))
                    .tracking(1.2)
                    .foregroundColor(PumpSkin.creamDim)
                    .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .overlay(alignment: .topTrailing) {
            if let day = days.first(where: { $0.date == hovered }) {
                DailyUsageTooltip(day: day, theme: theme).offset(y: -34)
            }
        }
    }
}

/// All / Today as two grade buttons: the selected one lit amber.
private struct GradeTabs: View {
    @Binding var showToday: Bool

    var body: some View {
        HStack(spacing: 6) {
            button("ALL", on: !showToday) { showToday = false }
            button("TODAY", on: showToday) { showToday = true }
        }
    }

    private func button(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(PumpSkin.plateFont(11))
                .tracking(1.3)
                .foregroundColor(on ? PumpSkin.housingDeep : PumpSkin.cream)
                .padding(.horizontal, 9)
                .padding(.vertical, 3)
                .background(RoundedRectangle(cornerRadius: 4).fill(on ? PumpSkin.amber : Color.clear))
                .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(on ? PumpSkin.amber : PumpSkin.cream.opacity(0.6), lineWidth: 1.2))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}
