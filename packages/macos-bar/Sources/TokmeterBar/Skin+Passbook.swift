// Skin+Passbook.swift — the "Passbook" skin: a bank savings passbook.
//
// Spend is posted like a bank posts entries: a navy cloth cover with a gilt
// stamp, then a ruled page where today's estimated cost is printed in dot
// matrix, models and projects are posted as debit lines, the readings sit in
// a memo block, and lifetime totals are the balance carried forward under a
// red double rule. A teller's stamp carries the billing block.
//
// Distinct from Paper on purpose: Paper is a broadsheet (serif display,
// kickers, leader dots). Passbook is a form — columns, blue ruling, printed
// mono entries, rubber stamps. Colour keeps a meaning: red marks totals and
// the stamp, green the cache stamp when the cache is healthy, status colours
// only for readings that need attention.

import SwiftUI

enum PassbookSkin: SkinSpec {
    static let displayName = "Passbook"
    static let tagline = "Spend posted to a ledger book"
    static let icon = "book.closed.fill"

    // MARK: Ink and stock

    /// Cover cloth.
    static let navy = Color(red: 0.114, green: 0.165, blue: 0.267)    // #1D2A44
    /// Gilt stamping on the cover; 8.9:1 on navy.
    static let gilt = Color(red: 0.902, green: 0.812, blue: 0.545)    // #E6CF8B
    /// The page.
    static let page = Color(red: 0.969, green: 0.957, blue: 0.925)    // #F7F4EC
    /// Printer ribbon ink; 14:1 on the page.
    static let ink = Color(red: 0.137, green: 0.149, blue: 0.169)     // #23262B
    /// Secondary print; 7:1 on the page.
    static let muted = Color(red: 0.333, green: 0.325, blue: 0.306)   // #55534E
    /// Blue ruling. Lines only, never text.
    static let ruling = Color(red: 0.725, green: 0.796, blue: 0.878)  // #B9CBE0
    /// Totals and the teller's stamp; 6.6:1 on the page.
    static let red = Color(red: 0.639, green: 0.153, blue: 0.122)     // #A3271F
    /// Cache stamp when the cache is doing its job; 6.4:1 on the page.
    static let green = Color(red: 0.122, green: 0.420, blue: 0.275)   // #1F6B46

    static let surface = page
    static let isLight = true
    static var gradient: [Color] { [page, page] }
    static let palette = ThemeColors(
        primary: navy,
        secondary: Color(red: 0.184, green: 0.290, blue: 0.451),     // #2F4A73 blue ink
        accent: navy,
        highlight: ink,
        warm: red,
        tertiary: green)
    static let fonts = ThemeFonts(heroDesign: .monospaced, heroWeight: .bold,
                                  valueDesign: .monospaced, valueWeight: .semibold,
                                  labelDesign: .serif, bodyDesign: .default)
    static var costInk: Color { ink }
    static let cornerRadius: CGFloat = 2
    /// Section-head row height above its rule; the index tabs match it so
    /// the rule runs straight under both.
    static let headRowHeight: CGFloat = 20

    // MARK: Optional hooks

    @MainActor static func weekChart(days: [DailyUsage], style: WeekChartStyle, theme: AppTheme) -> AnyView? {
        AnyView(Statement(days: days, theme: theme))
    }

    @MainActor static func modelTabs(showToday: Binding<Bool>, theme: AppTheme) -> AnyView? {
        AnyView(IndexTabs(showToday: showToday))
    }

    @MainActor static func disclosureLabel(expanded: Bool, theme: AppTheme) -> AnyView? {
        AnyView(MemorandaLabel(expanded: expanded))
    }

    @MainActor static func footnote(_ text: String, theme: AppTheme) -> AnyView? {
        AnyView(
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("NOTE").font(PassbookSkin.columnHeadFont).tracking(1.2).foregroundColor(navy)
                Text(text).font(PassbookSkin.print(9.5)).foregroundColor(muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .accessibilityElement(children: .combine)
        )
    }

    // MARK: Type

    /// Printed entries: the ribbon printer's mono.
    static func print(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        .system(size: size, weight: weight, design: .monospaced)
    }

    /// Column heads: small serif capitals, tracked, in navy.
    static let columnHeadFont = Font.system(size: 8.5, weight: .bold, design: .serif)
    static let columnHeadTracking: CGFloat = 1.2

    // MARK: - Hero: the cover and today's page

    struct Hero: View {
        let header: HeroHeader
        /// Observed directly so the page redraws on every poll.
        @ObservedObject private var loader: TokmeterLoader

        init(header: HeroHeader) {
            self.header = header
            _loader = ObservedObject(wrappedValue: header.loader)
        }

        var body: some View {
            VStack(spacing: 0) {
                cover
                Perforation()
                todaysPage
            }
            .frame(maxWidth: .infinity)
            .background(page)
        }

        // Cover: gilt stamping on navy cloth, with a security-print guilloché.
        private var cover: some View {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("TOKMETER")
                        .font(.system(size: 17, weight: .bold, design: .serif))
                        .tracking(3)
                    Text("SPEND LEDGER · \(Fmt.count(max(loader.allDaily.count, 1), "day").uppercased()) RECORDED")
                        .font(.system(size: 8, weight: .semibold, design: .serif))
                        .tracking(1.6)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                        .help("Days of usage recorded in your ledger. This book is a passbook-style view of what you spent.")
                }
                .foregroundColor(gilt)
                .accessibilityElement(children: .combine)
                .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 6)
                header.cacheWalletToggle
                CoverStatus(loader: loader)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .background(
                ZStack {
                    navy
                    Guilloche().stroke(gilt.opacity(0.16), lineWidth: 0.5)
                    Rectangle()
                        .strokeBorder(gilt.opacity(0.55), lineWidth: 0.75)
                        .padding(5)
                }
            )
        }

        @ViewBuilder
        private var todaysPage: some View {
            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .top, spacing: 8) {
                    VStack(alignment: .leading, spacing: 3) {
                        ColumnHead(text: "\(PassbookDate.long()) · posted today")
                        figures
                    }
                    Spacer(minLength: 0)
                    if loader.daemonPhase == .live {
                        TellerStamp(billing: loader.statbarSignals?.billingWindow)
                    }
                }
                breakdown
            }
            .padding(.horizontal, 18)
            .padding(.top, 10)
            .padding(.bottom, 10)
        }

        @ViewBuilder
        private var figures: some View {
            switch loader.daemonPhase {
            case .warming:
                VStack(alignment: .leading, spacing: 4) {
                    Text("UPDATING…")
                        .font(PassbookSkin.print(26, weight: .bold))
                        .foregroundColor(muted)
                    Text("Reading today's entries")
                        .font(PassbookSkin.print(10))
                        .foregroundColor(muted)
                }
                .accessibilityElement(children: .combine)
            case .offline, .needsNode:
                VStack(alignment: .leading, spacing: 3) {
                    Text(loader.daemonPhase == .needsNode ? "NODE.JS REQUIRED" : "SERVICE OFFLINE")
                        .font(PassbookSkin.print(22, weight: .bold))
                        .foregroundColor(ink)
                    Text(loader.daemonPhase == .needsNode
                        ? "Install Node 18+ to run the local service."
                        : "Usage service offline — press ▶ Start below.")
                        .font(.system(size: 10.5))
                        .foregroundColor(muted)
                }
                .accessibilityElement(children: .combine)
            case .live:
                VStack(alignment: .leading, spacing: 2) {
                    if header.estimatedCostText == "—" {
                        // Nothing priced at API rates today: say so plainly
                        // rather than printing a dash through the pin mask.
                        Text("NO ESTIMATE")
                            .font(PassbookSkin.print(26, weight: .bold))
                            .foregroundColor(muted)
                            .help("No usage today could be valued at model API rates.")
                    } else {
                        DotMatrixFigure(text: header.estimatedCostText, size: 44)
                            .help("Usage valued at model API rates. Tool-reported costs are listed separately below.")
                    }
                    Text(header.estimatedCostText == "—"
                         ? "\(Fmt.number(loader.todayTokens)) TOKENS TODAY"
                         : "\(Fmt.number(loader.todayTokens)) TOKENS · EST. API COST")
                        .font(PassbookSkin.print(11, weight: .medium))
                        .foregroundColor(ink)
                        .lineLimit(1)
                        .minimumScaleFactor(0.8)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("Posted today: estimated API cost \(header.estimatedCostText), \(Fmt.number(loader.todayTokens)) tokens")
            }
        }

        @ViewBuilder
        private var breakdown: some View {
            if loader.daemonPhase == .live {
                VStack(alignment: .leading, spacing: 0) {
                    if let basis = loader.statbarSignals?.costBasisToday {
                        if basis.reportedRecords > 0 {
                            EntryLine(particulars: "TOOL-REPORTED COST", amount: Fmt.cost(basis.reportedCost))
                        }
                        if basis.unavailableRecords > 0 {
                            EntryLine(particulars: "COST UNAVAILABLE FOR SOME USAGE", amount: "",
                                      ink: header.theme.statusWarning)
                        } else if basis.estimatedRecords + basis.reportedRecords == 0 {
                            EntryLine(particulars: "NO ENTRIES POSTED TODAY", amount: "")
                        }
                    }
                    Text("Entries are estimates, not your provider bill.")
                        .font(.system(size: 9.5, design: .serif).italic())
                        .foregroundColor(muted)
                        .padding(.top, 4)
                }
                .help("API estimates value usage at model rates. Tool-reported costs come from local usage records. Neither is a verified subscription bill.")
            }
        }
    }

    /// Cover status in gilt: what the service is doing, in the book's words.
    private struct CoverStatus: View {
        @ObservedObject var loader: TokmeterLoader

        var body: some View {
            Group {
                switch loader.daemonPhase {
                case .warming:
                    label("UPDATING", dot: gilt.opacity(0.6))
                case .offline, .needsNode:
                    label(loader.daemonPhase == .needsNode ? "NEEDS NODE" : "OFFLINE",
                          dot: Color(red: 0.96, green: 0.42, blue: 0.42))
                case .live:
                    if loader.lastError != nil && loader.hasFreshData {
                        label("STALE", dot: Color(red: 0.95, green: 0.70, blue: 0.30))
                            .help(loader.lastError ?? "")
                    } else if let live = loader.liveSession {
                        label("\(Fmt.projectBasename(live.project)) · \(Fmt.liveAge(live.ageSeconds))".uppercased(),
                              dot: Color(red: 0.42, green: 0.86, blue: 0.58))
                            .help("Live: \(live.provider) · \(Fmt.shortModel(live.model)) · last call \(Fmt.cost(live.lastRecordCost))")
                    } else {
                        label(loader.isDaemonAlive ? "LIVE" : "OFFLINE",
                              dot: loader.isDaemonAlive ? Color(red: 0.42, green: 0.86, blue: 0.58) : gilt.opacity(0.6))
                    }
                }
            }
        }

        private func label(_ text: String, dot: Color) -> some View {
            HStack(spacing: 5) {
                Circle().fill(dot).frame(width: 6, height: 6)
                Text(text)
                    .font(.system(size: 8.5, weight: .bold, design: .serif))
                    .tracking(1.2)
                    .foregroundColor(gilt)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .frame(maxWidth: 150, alignment: .trailing)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Status: \(text.lowercased())")
        }
    }

    // MARK: - Signals: the memo block

    struct Signals: View {
        let items: [SignalsRibbon.Item]
        let theme: AppTheme

        private var cache: SignalsRibbon.Item? { items.first { $0.id == "cache" } }

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .center) {
                    ColumnHead(text: "Memo · today's readings")
                    Spacer(minLength: 0)
                    if let cache {
                        RubberStamp(text: "CACHED \(cache.value)", color: cache.alert ?? green)
                            .help(cache.help)
                    }
                }
                .frame(height: 24)
                Rectangle().fill(navy).frame(height: 1.5)
                ForEach(items) { item in
                    MemoLine(item: item)
                }
            }
        }
    }

    private struct MemoLine: View {
        let item: SignalsRibbon.Item

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(item.label.uppercased())
                    .font(PassbookSkin.print(10.5, weight: .medium))
                    .foregroundColor(ink)
                    .frame(width: 92, alignment: .leading)
                    .lineLimit(1)
                Text(item.sub ?? "")
                    .font(PassbookSkin.print(9.5))
                    .foregroundColor(muted)
                    .lineLimit(1)
                if let elapsed = item.elapsed {
                    // The block's elapsed share, as a pencilled bar.
                    ZStack(alignment: .leading) {
                        Rectangle().fill(ruling).frame(width: 44, height: 4)
                        Rectangle().fill(item.alert ?? navy).frame(width: 44 * elapsed, height: 4)
                    }
                    .accessibilityHidden(true)
                }
                Spacer(minLength: 4)
                Text(item.value)
                    .font(PassbookSkin.print(12, weight: .bold))
                    .foregroundColor(item.alert ?? ink)
                    .lineLimit(1)
                    .contentTransition(.numericText())
            }
            .frame(height: 21)
            .overlay(alignment: .bottom) { Rectangle().fill(ruling).frame(height: 1) }
            .help(item.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(item.label): \(item.value)\(item.sub.map { ", " + $0 } ?? "")")
        }
    }

    // MARK: - Ledger: all-time totals, balance carried forward

    struct Ledger: View {
        let rows: [LedgerRowData]
        let theme: AppTheme

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                Rectangle().fill(navy).frame(height: 2)
                HStack(spacing: 8) {
                    ColumnHead(text: "All-time totals")
                    Spacer(minLength: 0)
                    ColumnHead(text: "Daily").frame(width: 62, alignment: .center)
                    ColumnHead(text: "Total").frame(width: 70, alignment: .trailing)
                    ColumnHead(text: "Change").frame(width: 56, alignment: .trailing)
                        .help("Change since the previous recorded day.")
                }
                .frame(height: 22)
                Rectangle().fill(navy).frame(height: 1)
                ForEach(rows) { row in
                    LedgerLine(row: row, theme: theme)
                }
                RedDoubleRule(color: red)
            }
        }
    }

    private struct LedgerLine: View {
        let row: LedgerRowData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .center, spacing: 8) {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    Text(row.name)
                        .font(.system(size: 13, weight: .semibold, design: .serif))
                        .foregroundColor(ink)
                    Text(row.note)
                        .font(.system(size: 9.5, design: .serif).italic())
                        .foregroundColor(muted)
                        .lineLimit(1)
                }
                .layoutPriority(1)
                Spacer(minLength: 2)
                MarginBars(values: row.spark)
                    .frame(width: 62, height: 14)
                    .modifier(SparklineUsageHover(days: row.sparkDays, theme: theme))
                Group {
                    if row.isWarming {
                        ShimmerBar(width: 52, height: 12, breathToggle: true)
                    } else {
                        Text(row.value)
                            .font(PassbookSkin.print(14, weight: .bold))
                            .foregroundColor(row.alert ?? ink)
                            .lineLimit(1)
                            .minimumScaleFactor(0.7)
                            .contentTransition(.numericText())
                    }
                }
                .frame(width: 70, alignment: .trailing)
                change.frame(width: 56, alignment: .trailing)
            }
            .frame(height: 26)
            .overlay(alignment: .bottom) { Rectangle().fill(ruling).frame(height: 1) }
            .accessibilityElement(children: .combine)
        }

        @ViewBuilder
        private var change: some View {
            if let trend = row.trend, !row.isWarming {
                let up = trend.percent >= 0
                Text("\(up ? "▲" : "▼")\(String(format: "%.1f", abs(trend.percent)))%")
                    .font(PassbookSkin.print(10.5, weight: .medium))
                    .foregroundColor(trend.metric == .cost && up ? theme.statusWarning : ink)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                    .help(trend.description)
                    .accessibilityLabel(trend.description)
            } else {
                Text("—").font(PassbookSkin.print(10.5)).foregroundColor(muted).accessibilityHidden(true)
            }
        }
    }

    // MARK: - Section head: a table head

    struct SectionHead: View {
        let label: String
        let count: Int
        let theme: AppTheme

        var body: some View {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    ColumnHead(text: label)
                    if count > 0 {
                        Text("\(count) \(count == 1 ? "ENTRY" : "ENTRIES")")
                            .font(PassbookSkin.print(8.5, weight: .medium))
                            .foregroundColor(muted)
                    }
                    Spacer(minLength: 0)
                }
                .frame(height: PassbookSkin.headRowHeight, alignment: .leading)
                Rectangle().fill(navy).frame(height: 1.5)
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
        }
    }

    // MARK: - Rows: posted entries

    struct ModelRow: View {
        let row: ModelRowData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .center, spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.name)
                        .font(PassbookSkin.print(11.5, weight: .medium))
                        .foregroundColor(ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let provider = row.provider {
                        Text(provider.uppercased())
                            .font(PassbookSkin.print(8.5))
                            .foregroundColor(muted)
                            .lineLimit(1)
                    }
                }
                .frame(width: 130, alignment: .leading)
                GeometryReader { geo in
                    Rectangle()
                        .fill(row.activityOnly ? ruling : navy)
                        .frame(width: max(2, geo.size.width * (row.activityOnly ? 0.08 : row.share)), height: 6)
                        .frame(maxHeight: .infinity)
                }
                .frame(height: 10)
                Text(row.activityOnly ? "n/a" : Fmt.money(row.model.cost))
                    .font(PassbookSkin.print(12, weight: row.activityOnly ? .regular : .bold))
                    .foregroundColor(row.activityOnly ? muted : ink)
                    .frame(width: 62, alignment: .trailing)
            }
            .frame(minHeight: 20)
            .overlay(alignment: .bottom) { Rectangle().fill(ruling).frame(height: 1).offset(y: 3) }
            .help(row.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(row.name): \(row.activityOnly ? "cost unavailable" : Fmt.money(row.model.cost))")
        }
    }

    struct ProjectRow: View {
        let project: ProjectData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(PassbookDate.short())
                    .font(PassbookSkin.print(9.5))
                    .foregroundColor(muted)
                    .frame(width: 44, alignment: .leading)
                Text(Fmt.projectBasename(project.project))
                    .font(PassbookSkin.print(11.5, weight: .medium))
                    .foregroundColor(ink)
                    .lineLimit(1)
                    .help(project.project)
                Spacer(minLength: 4)
                Text("\(Fmt.number(project.totalTokens)) TOK")
                    .font(PassbookSkin.print(9.5))
                    .foregroundColor(muted)
                    .lineLimit(1)
                Text(Fmt.money(project.totalCost))
                    .font(PassbookSkin.print(12, weight: .bold))
                    .foregroundColor(ink)
                    .frame(width: 62, alignment: .trailing)
            }
            // The section wraps each row in 6pt vertical padding; the ruling
            // sits at the bottom of that padded line, like a printed form.
            // The section pads each row 6pt top and bottom; give 3pt of each
            // back so projects print at the models' line pitch (~28pt).
            .padding(.vertical, -3)
            .overlay(alignment: .bottom) {
                Rectangle().fill(ruling).frame(height: 1).offset(y: 6)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(Fmt.projectBasename(project.project)): \(Fmt.number(project.totalTokens)) tokens, \(Fmt.money(project.totalCost)) today")
        }
    }

    // MARK: - Card: a ruled form panel

    struct Card: View {
        let role: Color
        var body: some View {
            Rectangle()
                .fill(page)
                .overlay(Rectangle().strokeBorder(ruling, lineWidth: 1))
                .overlay(alignment: .top) { Rectangle().fill(navy).frame(height: 1.5) }
        }
    }
}

// MARK: - Pieces

private struct ColumnHead: View {
    let text: String
    var body: some View {
        Text(text.uppercased())
            .font(PassbookSkin.columnHeadFont)
            .tracking(PassbookSkin.columnHeadTracking)
            .foregroundColor(PassbookSkin.navy)
            .lineLimit(1)
            .minimumScaleFactor(0.85)
    }
}

/// `TOOL-REPORTED COST ........ $0.40` as a printed line on the ruling.
private struct EntryLine: View {
    let particulars: String
    let amount: String
    var ink: Color = PassbookSkin.ink

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            Text(particulars).foregroundColor(ink)
            Spacer(minLength: 4)
            Text(amount).fontWeight(.bold).foregroundColor(PassbookSkin.ink)
        }
        .font(PassbookSkin.print(10.5, weight: .medium))
        .frame(height: 20)
        .overlay(alignment: .bottom) { Rectangle().fill(PassbookSkin.ruling).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }
}

/// The figure as a ribbon printer prints it: the mono glyphs read through a
/// grid of dots, so strokes break into pins.
private struct DotMatrixFigure: View {
    let text: String
    let size: CGFloat

    var body: some View {
        Text(text)
            .font(PassbookSkin.print(size, weight: .heavy))
            .foregroundColor(PassbookSkin.ink)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            .contentTransition(.numericText())
            .mask(
                Canvas { ctx, canvasSize in
                    let pitch: CGFloat = size / 19
                    let r = pitch * 0.47
                    var y: CGFloat = pitch / 2
                    while y < canvasSize.height {
                        var x: CGFloat = pitch / 2
                        while x < canvasSize.width {
                            ctx.fill(Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)),
                                     with: .color(.black))
                            x += pitch
                        }
                        y += pitch
                    }
                }
            )
    }
}

/// The teller's rubber stamp: the billing block's time left when a block is
/// open, otherwise the posting date. Struck at an angle, in red.
private struct TellerStamp: View {
    let billing: BillingWindow?

    var body: some View {
        let main: String = billing.map { remaining($0.remainingSec) } ?? PassbookDate.short()
        let top: String = billing == nil ? "TELLER" : "5-HR LIMIT"
        let sub: String = billing == nil ? "POSTED" : "LEFT"
        ZStack {
            Circle().strokeBorder(PassbookSkin.red, lineWidth: 2)
            Circle().strokeBorder(PassbookSkin.red, lineWidth: 1).padding(9)
            VStack(spacing: 1) {
                Text(top)
                    .font(.system(size: 6.5, weight: .bold, design: .serif))
                    .tracking(1.0)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(main)
                    .font(PassbookSkin.print(13, weight: .heavy))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                Text(sub)
                    .font(.system(size: 6.5, weight: .bold, design: .serif))
                    .tracking(1.2)
            }
            .foregroundColor(PassbookSkin.red)
            .padding(.horizontal, 12)
        }
        .frame(width: 72, height: 72)
        .rotationEffect(.degrees(-9))
        .opacity(0.9)
        .help(billing.map {
            String(format: "Claude 5-hour limit window (block #%d), %.0f%% elapsed, %@ so far.",
                   $0.blockNumber, $0.elapsedPct, Fmt.cost($0.cost))
        } ?? "Posted today.")
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(billing == nil ? "Posted \(main)" : "5-hour limit window: \(main) left")
    }

    private func remaining(_ seconds: Int) -> String {
        let h = seconds / 3600, m = (seconds % 3600) / 60
        return h > 0 ? "\(h)h\(m)m" : "\(m)m"
    }
}

/// A boxed rubber stamp, struck slightly crooked.
private struct RubberStamp: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text)
            .font(.system(size: 9.5, weight: .heavy, design: .serif))
            .tracking(1.6)
            .foregroundColor(color)
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .overlay(Rectangle().strokeBorder(color, lineWidth: 1.6))
            .rotationEffect(.degrees(4))
            .opacity(0.9)
            .accessibilityLabel(text.capitalized)
    }
}

/// Totals rule: two red lines.
private struct RedDoubleRule: View {
    let color: Color
    var body: some View {
        VStack(spacing: 1.5) {
            Rectangle().fill(color).frame(height: 1)
            Rectangle().fill(color).frame(height: 1)
        }
    }
}

/// Margin bars: one thin navy bar per posted day, newest last. All navy:
/// the ledger only carries settled days, so none of them is "today" (red).
private struct MarginBars: View {
    let values: [Double]

    var body: some View {
        GeometryReader { geo in
            let maxV = max(values.max() ?? 0, 0.0001)
            let n = max(values.count, 1)
            let gap: CGFloat = 2
            let w = max(1, (geo.size.width - gap * CGFloat(n - 1)) / CGFloat(n))
            HStack(alignment: .bottom, spacing: gap) {
                ForEach(Array(values.enumerated()), id: \.offset) { i, v in
                    Rectangle()
                        .fill(PassbookSkin.navy)
                        .frame(width: w, height: max(1, geo.size.height * CGFloat(v / maxV)))
                }
            }
            .frame(width: geo.size.width, height: geo.size.height, alignment: .bottomTrailing)
        }
        .accessibilityHidden(true)
    }
}

/// The page's torn-off edge under the cover: a row of perforations.
private struct Perforation: View {
    var body: some View {
        Canvas { ctx, size in
            ctx.fill(Path(CGRect(origin: .zero, size: size)), with: .color(PassbookSkin.navy))
            var x: CGFloat = 4
            while x < size.width {
                ctx.fill(Path(ellipseIn: CGRect(x: x - 2, y: size.height - 4, width: 4, height: 4)),
                         with: .color(PassbookSkin.page))
                x += 8
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

/// Security-print guilloché for the cover: interleaved sine bands.
private struct Guilloche: Shape {
    func path(in rect: CGRect) -> Path {
        var p = Path()
        let bands = 7
        for b in 0..<bands {
            let phase = CGFloat(b) * .pi / CGFloat(bands)
            let amp = rect.height * 0.32
            let mid = rect.midY
            var x: CGFloat = 0
            p.move(to: CGPoint(x: 0, y: mid + amp * sin(phase)))
            while x <= rect.width {
                let t = x / rect.width * .pi * 6 + phase
                p.addLine(to: CGPoint(x: x, y: mid + amp * sin(t) * cos(t * 0.5 + phase)))
                x += 2
            }
        }
        return p
    }
}

private enum PassbookDate {
    static func long(_ now: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE d MMM yyyy"
        return f.string(from: now)
    }

    static func short(_ now: Date = Date()) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "dd MMM"
        return f.string(from: now).uppercased()
    }
}

// MARK: - Hook views

/// Book index tabs for All / Today. They sit on the section's navy rule and
/// carry it across to the leading edge, so the header reads as one ruled row.
private struct IndexTabs: View {
    @Binding var showToday: Bool

    var body: some View {
        // Rule first, tabs over it: the open tab's page fill breaks the rule.
        ZStack(alignment: .bottomTrailing) {
            Rectangle().fill(PassbookSkin.navy).frame(height: 1.5)
                // Reach back under the shared Spacer to meet the head's rule.
                .padding(.leading, -40)
            HStack(alignment: .bottom, spacing: 3) {
                tab("All", on: !showToday) { showToday = false }
                tab("Today", on: showToday) { showToday = true }
            }
            .padding(.bottom, 1.5)
        }
        .frame(height: PassbookSkin.headRowHeight + 1.5, alignment: .bottom)
    }

    private func tab(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button { withAnimation(.easeOut(duration: 0.15)) { action() } } label: {
            Text(label.uppercased())
                .font(.system(size: 8.5, weight: on ? .heavy : .semibold, design: .serif))
                .tracking(1.1)
                .foregroundColor(on ? PassbookSkin.navy : PassbookSkin.muted)
                .padding(.horizontal, 8)
                .frame(height: on ? 18 : 15)
                .background(
                    UnevenRoundedRectangle(topLeadingRadius: 3, topTrailingRadius: 3)
                        .fill(on ? PassbookSkin.page : Color(red: 0.914, green: 0.890, blue: 0.824))
                )
                .overlay(
                    TabOutline().stroke(PassbookSkin.navy, lineWidth: 1)
                )
                // The open tab covers the rule, like a page tab over the edge.
                .offset(y: on ? 1.5 : 0)
                .zIndex(on ? 1 : 0)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? [.isSelected, .isButton] : .isButton)
    }

    /// Left, top and right edges only — a tab is open at the bottom.
    private struct TabOutline: Shape {
        func path(in rect: CGRect) -> Path {
            Path { p in
                p.move(to: CGPoint(x: rect.minX + 0.5, y: rect.maxY))
                p.addLine(to: CGPoint(x: rect.minX + 0.5, y: rect.minY + 3))
                p.addQuadCurve(to: CGPoint(x: rect.minX + 3, y: rect.minY + 0.5),
                               control: CGPoint(x: rect.minX + 0.5, y: rect.minY + 0.5))
                p.addLine(to: CGPoint(x: rect.maxX - 3, y: rect.minY + 0.5))
                p.addQuadCurve(to: CGPoint(x: rect.maxX - 0.5, y: rect.minY + 3),
                               control: CGPoint(x: rect.maxX - 0.5, y: rect.minY + 0.5))
                p.addLine(to: CGPoint(x: rect.maxX - 0.5, y: rect.maxY))
            }
        }
    }
}

/// The usage-details disclosure as a memoranda row: a printed triangle, the
/// column-head label, and OPEN / CLOSE on the right, on a navy rule.
private struct MemorandaLabel: View {
    let expanded: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(expanded ? "▾" : "▸")
                .font(.system(size: 10, weight: .heavy))
                .foregroundColor(PassbookSkin.navy)
                .accessibilityHidden(true)
            ColumnHead(text: "Memoranda · usage details")
            Spacer(minLength: 4)
            Text(expanded ? "HIDE" : "SHOW")
                .font(PassbookSkin.print(8.5, weight: .medium))
                .foregroundColor(PassbookSkin.muted)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 3)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .bottom) {
            // The host row keeps 5pt of HStack spacing before its Spacer;
            // run the rule through it so it meets the page's right margin.
            Rectangle().fill(PassbookSkin.navy).frame(height: 1.5).padding(.trailing, -5).offset(y: 4)
        }
        .accessibilityLabel("Memoranda, usage details")
    }
}

/// The 7-day chart as a statement: one posted line per recorded day with a
/// margin bar, tokens and the debit. Today is still accumulating, so it is
/// printed in red and marked PENDING. Closes with a 7-day total under a red
/// double rule. Hover a line for the day's tooltip.
private struct Statement: View {
    let days: [DailyUsage]
    let theme: AppTheme
    @State private var hovered: String?

    private var todayKey: String { LocalDay.todayKey() }

    var body: some View {
        let maxCost = max(days.map(\.cost).max() ?? 0, 0.0001)
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                head("Date").frame(width: 50, alignment: .leading)
                head("Particulars")
                Spacer(minLength: 0)
                head("Tokens").frame(width: 62, alignment: .trailing)
                head("Debit").frame(width: 62, alignment: .trailing)
            }
            .frame(height: 18)
            Rectangle().fill(PassbookSkin.navy).frame(height: 1)
            ForEach(days) { day in
                line(day, maxCost: maxCost)
            }
            HStack(spacing: 8) {
                Text("").frame(width: 50)
                Text("\(days.count)-DAY TOTAL")
                    .font(PassbookSkin.print(10, weight: .bold))
                    .foregroundColor(PassbookSkin.ink)
                Spacer(minLength: 0)
                Text(Fmt.number(days.reduce(0) { $0 + $1.tokens }))
                    .font(PassbookSkin.print(10.5, weight: .bold))
                    .frame(width: 62, alignment: .trailing)
                Text(Fmt.cost(days.reduce(0) { $0 + $1.cost }))
                    .font(PassbookSkin.print(11.5, weight: .heavy))
                    .frame(width: 62, alignment: .trailing)
            }
            .foregroundColor(PassbookSkin.ink)
            .frame(height: 22)
            VStack(spacing: 1.5) {
                Rectangle().fill(PassbookSkin.red).frame(height: 1)
                Rectangle().fill(PassbookSkin.red).frame(height: 1)
            }
        }
        .overlay(alignment: .topTrailing) {
            if let day = days.first(where: { $0.date == hovered }) {
                DailyUsageTooltip(day: day, theme: theme)
                    .offset(y: -34)
                    .allowsHitTesting(false)
            }
        }
    }

    private func head(_ text: String) -> some View {
        Text(text.uppercased())
            .font(PassbookSkin.columnHeadFont)
            .tracking(PassbookSkin.columnHeadTracking)
            .foregroundColor(PassbookSkin.navy)
    }

    private func line(_ day: DailyUsage, maxCost: Double) -> some View {
        let pending = day.date == todayKey
        let ink = pending ? PassbookSkin.red : PassbookSkin.ink
        return HStack(spacing: 8) {
            Text(PassbookSkin.statementDate(day.date))
                .font(PassbookSkin.print(9.5))
                .foregroundColor(pending ? PassbookSkin.red : PassbookSkin.muted)
                .frame(width: 50, alignment: .leading)
            GeometryReader { geo in
                Rectangle()
                    .fill(pending ? PassbookSkin.red : PassbookSkin.navy)
                    .frame(width: max(1, geo.size.width * CGFloat(day.cost / maxCost)), height: 5)
                    .frame(maxHeight: .infinity)
            }
            .frame(height: 10)
            if pending {
                Text("PENDING")
                    .font(.system(size: 7.5, weight: .heavy, design: .serif))
                    .tracking(1.2)
                    .foregroundColor(PassbookSkin.red)
                    .padding(.horizontal, 3)
                    .overlay(Rectangle().strokeBorder(PassbookSkin.red, lineWidth: 1))
                    .help("Today is still accumulating.")
            }
            Text(Fmt.number(day.tokens))
                .font(PassbookSkin.print(10))
                .foregroundColor(ink)
                .frame(width: 62, alignment: .trailing)
            Text(Fmt.cost(day.cost))
                .font(PassbookSkin.print(11, weight: .bold))
                .foregroundColor(ink)
                .frame(width: 62, alignment: .trailing)
        }
        .frame(height: 19)
        .background(hovered == day.date ? PassbookSkin.ruling.opacity(0.25) : Color.clear)
        .overlay(alignment: .bottom) { Rectangle().fill(PassbookSkin.ruling).frame(height: 1) }
        .contentShape(Rectangle())
        .onHover { inside in
            if inside { hovered = day.date } else if hovered == day.date { hovered = nil }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(day.date)\(pending ? ", pending" : ""): \(Fmt.number(day.tokens)) tokens, \(Fmt.cost(day.cost))")
    }
}

extension PassbookSkin {
    /// "2026-09-07" → "07 SEP".
    static func statementDate(_ iso: String) -> String {
        let inF = DateFormatter()
        inF.locale = Locale(identifier: "en_US_POSIX")
        inF.dateFormat = "yyyy-MM-dd"
        guard let d = inF.date(from: iso) else { return String(iso.suffix(5)) }
        let outF = DateFormatter()
        outF.locale = Locale(identifier: "en_US_POSIX")
        outF.dateFormat = "dd MMM"
        return outF.string(from: d).uppercased()
    }
}
