// Skin+Meter.swift — the "Meter" skin: tokmeter as a sealed utility meter.
//
// A brushed-aluminium faceplate under a glass dome. Today's tokens and
// estimated cost turn on odometer drums (black wheels, red fractions). A
// Ferraris disc in a recessed window spins at the live burn rate, calibrated
// to one revolution per cent spent. The ratio signals are sub-dials, the
// billing block is a clock dial, lifetime figures sit on a sealed
// totalizer, and model and project rows are circuits and sub-meters.
//
// Every figure is a real reading. Drums show the formatted value's digits
// (leading zeros pad the window, as a meter's would); "—" readings show
// dashed wheels, never a made-up number. Colour means something: red marks
// fractions and danger zones, the lamps report the service's state.

import SwiftUI

enum MeterSkin: SkinSpec {
    static let displayName = "Meter"
    static let tagline = "Utility meter under glass"
    static let icon = "gauge.with.dots.needle.33percent"
    static let surface = Plate.face
    static let isLight = true
    static var gradient: [Color] { [Plate.faceTop, Plate.faceBottom] }
    static let palette = ThemeColors(
        primary: Plate.ink,
        secondary: Plate.engrave,
        accent: Plate.ink,
        highlight: Plate.ink,
        warm: Plate.red,
        tertiary: Plate.greenInk
    )
    static let fonts = ThemeFonts(heroDesign: .monospaced, heroWeight: .medium,
                                  valueDesign: .monospaced, valueWeight: .medium,
                                  labelDesign: .default, bodyDesign: .default)
    static var costInk: Color { Plate.ink }
    static let cornerRadius: CGFloat = 6

    static func weekChart(days: [DailyUsage], style: WeekChartStyle, theme: AppTheme) -> AnyView? {
        AnyView(LoadProfile(days: days, style: style, theme: theme))
    }

    static func modelTabs(showToday: Binding<Bool>, theme: AppTheme) -> AnyView? {
        AnyView(NotchTabs(showToday: showToday))
    }

    static func disclosureLabel(expanded: Bool, theme: AppTheme) -> AnyView? {
        AnyView(
            HStack(spacing: 8) {
                // A small black knob; its pointer turns as the cover opens.
                ZStack {
                    Circle().fill(LinearGradient(colors: [Color(white: 0.24), Color(white: 0.07)],
                                                 startPoint: .top, endPoint: .bottom))
                        .overlay(Circle().strokeBorder(Color.black, lineWidth: 0.8))
                    Rectangle().fill(Color(white: 0.92)).frame(width: 1.5, height: 5).offset(y: -3)
                        .rotationEffect(.degrees(expanded ? 180 : 90))
                }
                .frame(width: 14, height: 14)
                .shadow(color: .black.opacity(0.5), radius: 0, x: 0, y: 1)
                .accessibilityHidden(true)
                Engraved("Usage details", size: 8.5, color: Plate.ink)
                Spacer(minLength: 0)
                Engraved(expanded ? "Cover open" : "Cover closed", size: 7.5, color: Plate.muted)
            }
        )
    }

    static func footnote(_ text: String, theme: AppTheme) -> AnyView? {
        AnyView(
            Text(text)
                .font(.system(size: 9.5, weight: .medium))
                .foregroundColor(Plate.muted)
                .shadow(color: .white.opacity(0.7), radius: 0, x: 0, y: 1)
                .fixedSize(horizontal: false, vertical: true)
        )
    }

    // MARK: - Materials

    enum Plate {
        static let faceTop = Color(red: 0.894, green: 0.902, blue: 0.910)     // #E4E6E8
        static let face = Color(red: 0.839, green: 0.851, blue: 0.863)        // #D6D9DC
        static let faceBottom = Color(red: 0.788, green: 0.800, blue: 0.816)  // #C9CCD0
        static let bezel = Color(red: 0.545, green: 0.565, blue: 0.588)       // #8B9096
        static let ink = Color(red: 0.106, green: 0.114, blue: 0.122)         // #1B1D1F
        static let engrave = Color(red: 0.231, green: 0.247, blue: 0.267)     // #3B3F44
        static let muted = Color(red: 0.290, green: 0.310, blue: 0.333)       // #4A4F55, ≥5:1 on face
        static let window = Color(red: 0.082, green: 0.090, blue: 0.102)      // #15171A
        static let wheel = Color(red: 0.055, green: 0.059, blue: 0.063)       // #0E0F10
        static let red = Color(red: 0.753, green: 0.196, blue: 0.165)         // #C0322A
        static let redInk = Color(red: 0.588, green: 0.118, blue: 0.086)      // #961E16, text on face
        static let greenInk = Color(red: 0.118, green: 0.420, blue: 0.196)    // #1E6B32
        static let ledGreen = Color(red: 0.184, green: 0.635, blue: 0.290)
        static let ledAmber = Color(red: 0.890, green: 0.635, blue: 0.102)
        static let ledRed = Color(red: 0.839, green: 0.196, blue: 0.165)
        static let dialFace = Color(red: 0.953, green: 0.953, blue: 0.945)    // #F3F3F1
    }

    // MARK: - Hero: the meter face

    struct Hero: View {
        let header: HeroHeader
        @ObservedObject private var loader: TokmeterLoader

        init(header: HeroHeader) {
            self.header = header
            _loader = ObservedObject(wrappedValue: header.loader)
        }

        var body: some View {
            VStack(alignment: .leading, spacing: 10) {
                ratingPlate
                HStack(spacing: 8) {
                    StatusLamp(loader: loader)
                    Spacer(minLength: 4)
                    cacheKey
                }
                Groove()
                registers
            }
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(faceplate)
            .overlay(dome.allowsHitTesting(false))
            .padding(.horizontal, 10)
            .padding(.top, 10)
            .padding(.bottom, 4)
        }

        private var ratingPlate: some View {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("TOKMETER")
                        .font(.system(size: 20, weight: .heavy).width(.expanded))
                        .tracking(2.6)
                        .foregroundColor(Plate.ink)
                        .shadow(color: .white.opacity(0.8), radius: 0, x: 0, y: 1)
                        .accessibilityAddTraits(.isHeader)
                    Engraved("Single-phase token meter · Type TM-1", size: 7.5)
                }
                Spacer(minLength: 6)
                VStack(alignment: .trailing, spacing: 3) {
                    Engraved("Kd 1¢ / rev", size: 8, mono: true)
                        .help("Disc constant: the disc turns once for every cent spent at the current burn rate.")
                    Engraved(String(format: "No. %06d", loader.allDaily.count), size: 8, mono: true)
                        .help("Days recorded in the ledger.")
                }
            }
        }

        // The phases, honestly: shimmer while warming, a plain "no reading"
        // plate while offline, the registers only when the service is live.
        @ViewBuilder
        private var registers: some View {
            switch loader.daemonPhase {
            case .warming:
                VStack(alignment: .leading, spacing: 8) {
                    Engraved("Reading the logs…", size: 8)
                    header.skeletonHero
                }
            case .offline, .needsNode:
                VStack(alignment: .leading, spacing: 4) {
                    Engraved(loader.daemonPhase == .needsNode ? "No reading · Node.js required"
                                                               : "No reading · usage service offline",
                             size: 9, color: Plate.redInk)
                    Text(loader.daemonPhase == .needsNode
                         ? "Install Node 18+ to run the local service."
                         : "Press ▶ Start below to bring it up.")
                        .font(.system(size: 11))
                        .foregroundColor(Plate.ink)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            case .live:
                VStack(alignment: .leading, spacing: 10) {
                    register(label: "Tokens\ntoday",
                             reading: Reading(Fmt.number(loader.todayTokens)),
                             unit: { Reading(Fmt.number(loader.todayTokens)).unit + " tok" },
                             minCells: 4,
                             a11y: "\(Fmt.number(loader.todayTokens)) tokens today")
                    register(label: "Est. cost\ntoday",
                             reading: Reading(header.estimatedCostText),
                             unit: { (Reading(header.estimatedCostText).unit + " USD").trimmingCharacters(in: .whitespaces) },
                             minCells: 5,
                             a11y: "Estimated API cost today \(header.estimatedCostText)")
                        .help("Usage valued at model API rates. Tool-reported costs are listed separately below.")
                    DiscWindow(burn: loader.statbarSignals?.burnRate, isVisible: header.isVisible)
                    breakdown
                }
            }
        }

        private func register(label: String, reading: Reading, unit: () -> String,
                              minCells: Int, a11y: String) -> some View {
            HStack(alignment: .center, spacing: 10) {
                Engraved(label, size: 8.5)
                    .frame(width: 70, alignment: .leading)
                    .fixedSize(horizontal: false, vertical: true)
                DrumWindow(reading: reading, size: .large, minCells: minCells)
                Spacer(minLength: 4)
                Engraved(unit(), size: 9.5, color: Plate.ink)
                    .lineLimit(1)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(a11y)
        }

        @ViewBuilder
        private var breakdown: some View {
            if let basis = loader.statbarSignals?.costBasisToday {
                VStack(alignment: .leading, spacing: 3) {
                    if basis.reportedRecords > 0 {
                        HStack {
                            Engraved("Tool-reported cost", size: 8)
                            Spacer()
                            Text(Fmt.cost(basis.reportedCost))
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundColor(Plate.ink)
                        }
                    }
                    if basis.unavailableRecords > 0 {
                        Engraved("Cost unavailable for some usage", size: 8, color: Plate.redInk)
                    } else if basis.estimatedRecords + basis.reportedRecords == 0 {
                        Engraved("No usage recorded today", size: 8)
                    }
                }
                .help("API estimates value usage at model rates. Tool-reported costs come from local usage records. Neither is a verified subscription bill.")
            }
        }

        /// A black bakelite key that opens the cache & context wallet. Its lamp
        /// follows context pressure.
        @ViewBuilder
        private var cacheKey: some View {
            if let signals = loader.statbarSignals, ContextTelemetryPanel.hasContent(signals) {
                let status = signals.contextPressure?.status
                let lamp: Color? = status == "critical" ? Plate.ledRed : (status == "high" ? Plate.ledAmber : nil)
                Button {
                    withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) {
                        header.showCachePanel = true
                    }
                } label: {
                    HStack(spacing: 5) {
                        if let lamp { Lamp(color: lamp, on: true, size: 6) }
                        Image(systemName: "tray.full.fill").font(.system(size: 9, weight: .semibold))
                        Text("CACHE").font(.system(size: 8.5, weight: .bold).width(.expanded)).tracking(1.2)
                    }
                    .foregroundColor(Color(white: 0.93))
                    .padding(.horizontal, 8)
                    .frame(height: 22)
                    .background(BakeliteKey())
                }
                .buttonStyle(.plain)
                .help(status == "critical" || status == "high"
                      ? "Cache & context — context drag is \(status ?? "high"). Open the wallet."
                      : "Cache & context wallet — open it.")
                .accessibilityLabel("Cache and context wallet")
            }
        }

        private var faceplate: some View {
            RoundedRectangle(cornerRadius: 12)
                .fill(LinearGradient(colors: [Plate.faceTop, Plate.face, Plate.faceBottom],
                                     startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Plate.bezel, lineWidth: 1))
                .overlay(alignment: .top) {
                    Rectangle().fill(Color.white.opacity(0.9)).frame(height: 1)
                        .padding(.horizontal, 10).padding(.top, 1)
                }
                .shadow(color: .black.opacity(0.28), radius: 8, x: 0, y: 5)
        }

        /// The glass dome: a specular arc at the top left and a faint diagonal
        /// sheen. Static — it costs nothing while the popover is idle.
        private var dome: some View {
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(RadialGradient(colors: [.white.opacity(0.50), .white.opacity(0.10), .clear],
                                         center: UnitPoint(x: 0.18, y: -0.08),
                                         startRadius: 0, endRadius: 260))
                RoundedRectangle(cornerRadius: 12)
                    .fill(LinearGradient(stops: [
                        .init(color: .clear, location: 0.60),
                        .init(color: .white.opacity(0.16), location: 0.66),
                        .init(color: .clear, location: 0.72),
                    ], startPoint: .topLeading, endPoint: .bottomTrailing))
            }
            .blendMode(.screen)
            .accessibilityHidden(true)
        }
    }

    // MARK: - Signals: sub-dials

    struct Signals: View {
        let items: [SignalsRibbon.Item]
        let theme: AppTheme

        /// Burn already turns the disc on the face, so the dials carry the
        /// ratios and the billing block.
        private var dials: [SignalsRibbon.Item] { items.filter { $0.id != "burn" } }

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                Groove()
                HStack {
                    Engraved("Sub-dials · today", size: 8)
                    Spacer()
                    if let burn = items.first(where: { $0.id == "burn" }) {
                        HStack(spacing: 4) {
                            Engraved("Burn", size: 8)
                            Text(burn.value + "/hr")
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundColor(burn.alert ?? Plate.ink)
                        }
                        .help(burn.help)
                        .accessibilityElement(children: .ignore)
                        .accessibilityLabel("Burn rate \(burn.value) per hour")
                    }
                }
                LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 6),
                                         count: max(1, min(dials.count, 4))),
                          spacing: 10) {
                    ForEach(dials) { item in
                        DialCell(item: item)
                    }
                }
            }
        }
    }

    // MARK: - Ledger: the sealed totalizer

    struct Ledger: View {
        let rows: [LedgerRowData]
        let theme: AppTheme

        var body: some View {
            VStack(alignment: .leading, spacing: 8) {
                Groove()
                HStack(alignment: .center) {
                    Engraved("Totalizer · sealed", size: 8)
                    Spacer()
                    Engraved("Day chg", size: 8, color: Plate.muted)
                    LeadSeal()
                }
                ForEach(rows) { row in
                    LedgerLine(row: row, theme: theme)
                }
            }
        }
    }

    // MARK: - Section head

    struct SectionHead: View {
        let label: String
        let count: Int
        let theme: AppTheme

        var body: some View {
            VStack(alignment: .leading, spacing: 7) {
                Groove()
                HStack(spacing: 8) {
                    Engraved(label.replacingOccurrences(of: "’", with: "'"), size: 8.5, color: Plate.ink)
                    if count > 0 {
                        DrumWindow(reading: Reading("\(count)"), size: .tiny, minCells: 2)
                            .accessibilityHidden(true)
                    }
                    Spacer(minLength: 0)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(label), \(count)")
            .accessibilityAddTraits(.isHeader)
        }
    }

    // MARK: - Model row: a circuit

    struct ModelRow: View {
        let row: ModelRowData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 0) {
                    Text(row.name)
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(Plate.ink)
                        .lineLimit(1)
                        .truncationMode(.middle)
                    if let provider = row.provider {
                        Text(provider)
                            .font(.system(size: 9, design: .monospaced))
                            .foregroundColor(Plate.muted)
                            .lineLimit(1)
                    }
                }
                .frame(width: 112, alignment: .leading)
                LoadBar(share: row.activityOnly ? 0 : row.share)
                if row.activityOnly {
                    Engraved("n/a", size: 8.5, color: Plate.muted)
                        .frame(minWidth: 40, alignment: .trailing)
                } else {
                    DrumWindow(reading: Reading(Fmt.cost(row.model.cost)), size: .small, minCells: 3)
                }
            }
            .padding(.vertical, 5)
            .overlay(alignment: .bottom) { Hairline() }
            .help(row.help)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(row.activityOnly
                ? "\(row.name), cost unavailable"
                : "\(row.name), \(Fmt.cost(row.model.cost))")
        }
    }

    // MARK: - Project row: a sub-meter

    struct ProjectRow: View {
        let project: ProjectData
        let theme: AppTheme

        var body: some View {
            HStack(alignment: .center, spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(Fmt.projectBasename(project.project))
                        .font(.system(size: 12.5, weight: .semibold))
                        .foregroundColor(Plate.ink)
                        .lineLimit(1)
                        .help(project.project)
                    Text("\(Fmt.number(project.totalTokens)) tok today")
                        .font(.system(size: 10, design: .monospaced))
                        .foregroundColor(Plate.muted)
                }
                Spacer(minLength: 6)
                DrumWindow(reading: Reading(Fmt.cost(project.totalCost)), size: .small, minCells: 3)
            }
            .padding(.bottom, 6)
            .overlay(alignment: .bottom) { Hairline() }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(Fmt.projectBasename(project.project)), \(Fmt.number(project.totalTokens)) tokens, \(Fmt.cost(project.totalCost)) today")
        }
    }

    // MARK: - Card: a recessed sub-plate

    struct Card: View {
        let role: Color
        var body: some View {
            RoundedRectangle(cornerRadius: MeterSkin.cornerRadius)
                .fill(LinearGradient(colors: [Plate.faceBottom, Plate.faceTop],
                                     startPoint: .top, endPoint: .bottom))
                .overlay(RoundedRectangle(cornerRadius: MeterSkin.cornerRadius)
                    .strokeBorder(Plate.bezel.opacity(0.8), lineWidth: 0.8))
        }
    }
}

// MARK: - Parts

/// A formatted reading split for the drums: "$10.23" → 10 · 23, "34.2M" →
/// 34 · 2 · "M". Anything without digits ("—") reads as dashed wheels.
private struct Reading {
    let whole: String
    let fraction: String
    let unit: String
    var hasDigits: Bool { !(whole + fraction).isEmpty }

    init(_ formatted: String) {
        let s = formatted.replacingOccurrences(of: "$", with: "").replacingOccurrences(of: ",", with: "")
        var whole = "", fraction = "", unit = ""
        var inFraction = false, inUnit = false
        for ch in s {
            if !inUnit, ch.isASCII, ch.isNumber {
                if inFraction { fraction.append(ch) } else { whole.append(ch) }
            } else if !inUnit, ch == ".", !inFraction {
                inFraction = true
            } else {
                inUnit = true
                if !ch.isWhitespace { unit.append(ch) }
            }
        }
        self.whole = whole
        self.fraction = fraction
        self.unit = unit
    }
}

private enum DrumSize {
    case large, small, tiny
    var cell: CGSize {
        switch self {
        case .large: return CGSize(width: 19, height: 30)
        case .small: return CGSize(width: 13, height: 20)
        case .tiny: return CGSize(width: 10, height: 15)
        }
    }
    var font: CGFloat {
        switch self {
        case .large: return 20
        case .small: return 13
        case .tiny: return 10
        }
    }
}

/// Odometer drums in a black window. Each wheel rolls its digit; fraction
/// wheels are red. Wheels are keyed from the decimal point outward so a
/// number gaining a digit rolls in, rather than every wheel shifting.
private struct DrumWindow: View {
    let reading: Reading
    var size: DrumSize = .small
    var minCells: Int = 0

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private struct Cell: Identifiable {
        let id: String
        let glyph: String
        let red: Bool
        var point = false
    }

    private var cells: [Cell] {
        guard reading.hasDigits else {
            return (0..<max(minCells, 3)).map { Cell(id: "d\($0)", glyph: "–", red: false) }
        }
        let padCount = max(0, minCells - reading.whole.count - reading.fraction.count)
        let whole = String(repeating: "0", count: padCount) + reading.whole
        var out: [Cell] = whole.reversed().enumerated().map { i, ch in
            Cell(id: "w\(i)", glyph: String(ch), red: false)
        }.reversed()
        if !reading.fraction.isEmpty { out.append(Cell(id: "pt", glyph: ".", red: false, point: true)) }
        out += reading.fraction.enumerated().map { i, ch in
            Cell(id: "f\(i)", glyph: String(ch), red: true)
        }
        return out
    }

    var body: some View {
        HStack(spacing: size == .tiny ? 1 : 2) {
            ForEach(cells) { cell in
                if cell.point {
                    // The meter's decimal point: a dot painted between wheels.
                    Circle().fill(Color(white: 0.96))
                        .frame(width: size == .large ? 3.5 : 2.5, height: size == .large ? 3.5 : 2.5)
                        .frame(height: size.cell.height, alignment: .bottom)
                        .padding(.bottom, size == .large ? 5 : 3)
                        .accessibilityHidden(true)
                } else {
                Text(cell.glyph)
                    .font(.system(size: size.font, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(white: 0.96))
                    .contentTransition(.numericText())
                    .animation(reduceMotion ? nil : .spring(response: 0.5, dampingFraction: 0.86), value: cell.glyph)
                    .frame(width: size.cell.width, height: size.cell.height)
                    .background(wheel(red: cell.red))
                    .clipped()
                }
            }
        }
        .padding(size == .tiny ? 2 : 3)
        .background(
            RoundedRectangle(cornerRadius: 3)
                .fill(MeterSkin.Plate.wheel)
                .overlay(RoundedRectangle(cornerRadius: 3)
                    .strokeBorder(Color.black.opacity(0.85), lineWidth: 1))
        )
        // The window's lower lip catches the light.
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.7)).frame(height: 1).offset(y: 1)
        }
        .fixedSize()
    }

    /// A wheel is a cylinder: dark at the top and bottom edges, lit across
    /// the middle where the digit faces the window.
    private func wheel(red: Bool) -> LinearGradient {
        let edge = red ? Color(red: 0.23, green: 0.04, blue: 0.03) : Color.black
        let mid = red ? Color(red: 0.70, green: 0.17, blue: 0.13) : Color(red: 0.23, green: 0.235, blue: 0.247)
        let shoulder = red ? Color(red: 0.60, green: 0.13, blue: 0.10) : Color(red: 0.165, green: 0.173, blue: 0.180)
        return LinearGradient(stops: [
            .init(color: edge, location: 0),
            .init(color: shoulder, location: 0.22),
            .init(color: mid, location: 0.5),
            .init(color: shoulder, location: 0.78),
            .init(color: edge, location: 1),
        ], startPoint: .top, endPoint: .bottom)
    }
}

/// The Ferraris disc seen edge-on through its window, with the burn rate.
/// It turns once per cent spent at the current rate, up to 3 rev/s, and
/// stops when the popover is hidden, Reduce Motion is on, or nothing is
/// burning.
private struct DiscWindow: View {
    let burn: BurnRate?
    let isVisible: Bool

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var costPerHour: Double {
        guard let burn, burn.recordsInWindow > 0 else { return 0 }
        return burn.costPerHour
    }
    private static let maxRevsPerSecond = 3.0
    private var revsPerSecond: Double {
        min(costPerHour * 100 / 3600, Self.maxRevsPerSecond)
    }
    private var capped: Bool { costPerHour * 100 / 3600 > Self.maxRevsPerSecond }

    var body: some View {
        HStack(spacing: 12) {
            TimelineView(.animation(minimumInterval: 1.0 / 30, paused: !isVisible || reduceMotion || revsPerSecond == 0)) { ctx in
                let phase = revsPerSecond == 0 || reduceMotion || !isVisible
                    ? 0.12
                    : (ctx.date.timeIntervalSinceReferenceDate * revsPerSecond).truncatingRemainder(dividingBy: 1)
                Canvas { gc, size in drawDisc(gc, size: size, phase: phase) }
            }
            .frame(height: 30)
            .accessibilityHidden(true)
            VStack(alignment: .trailing, spacing: 1) {
                Text(costPerHour > 0 ? Fmt.costPerHour(costPerHour).replacingOccurrences(of: "/hr", with: "") : "Idle")
                    .font(.system(size: 16, weight: .medium, design: .monospaced))
                    .foregroundColor(Color(white: 0.96))
                    .contentTransition(.numericText())
                Text(costPerHour > 0 ? (capped ? "PER HOUR · MAX" : "PER HOUR") : "NO LOAD")
                    .font(.system(size: 7.5, weight: .bold).width(.expanded))
                    .tracking(1.4)
                    .foregroundColor(Color(red: 0.70, green: 0.72, blue: 0.75))
            }
            .fixedSize()
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(MeterSkin.Plate.window)
                .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color.black, lineWidth: 1))
        )
        .overlay(alignment: .bottom) {
            Rectangle().fill(Color.white.opacity(0.75)).frame(height: 1).padding(.horizontal, 4).offset(y: 1)
        }
        .help(burnHelp)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(costPerHour > 0
            ? "Meter disc: burn rate \(Fmt.costPerHour(costPerHour).replacingOccurrences(of: "/hr", with: "")) per hour"
            : "Meter disc idle: no spend in the last hour")
    }

    private var burnHelp: String {
        guard let burn, burn.recordsInWindow > 0 else {
            return "No spend recorded in the last hour, so the disc is still."
        }
        return "Burn rate over the last \(burn.windowMinutes) min — \(burn.recordsInWindow) record(s). "
            + "The disc turns once per cent at this rate"
            + (capped ? " (shown at its 3 rev/s maximum)." : ".")
    }

    private func drawDisc(_ gc: GraphicsContext, size: CGSize, phase: Double) {
        let cx = size.width / 2, cy = size.height / 2
        let rx = size.width / 2 - 2, ry: CGFloat = 8
        // Rim (the disc's edge), then its top face.
        gc.fill(Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry + 2, width: rx * 2, height: ry * 2)),
                with: .color(Color(red: 0.60, green: 0.63, blue: 0.65)))
        gc.fill(Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: rx * 2, height: ry * 2)),
                with: .linearGradient(Gradient(colors: [Color(red: 0.86, green: 0.88, blue: 0.90),
                                                        Color(red: 0.72, green: 0.75, blue: 0.78)]),
                                      startPoint: CGPoint(x: cx, y: cy - ry), endPoint: CGPoint(x: cx, y: cy + ry)))
        // Graduations and the red index mark, on the near half of the rim.
        let base = phase * 2 * .pi
        for i in 0..<20 {
            let theta = base + Double(i) * 2 * .pi / 20
            let depth = cos(theta)
            guard depth > 0 else { continue }
            let x = cx + rx * CGFloat(sin(theta))
            var tick = Path()
            tick.move(to: CGPoint(x: x, y: cy - ry * 0.55))
            tick.addLine(to: CGPoint(x: x, y: cy + ry * 0.9))
            gc.stroke(tick, with: .color(Color(red: 0.42, green: 0.45, blue: 0.48).opacity(0.35 + 0.65 * depth)),
                      lineWidth: 1)
        }
        let depth = cos(base)
        if depth > 0 {
            let x = cx + rx * CGFloat(sin(base))
            let w = max(1.5, 8 * CGFloat(depth))
            gc.fill(Path(CGRect(x: x - w / 2, y: cy - ry * 0.75, width: w, height: ry * 1.75)),
                    with: .color(MeterSkin.Plate.red))
        }
        // Spindle shadow line across the window.
        var axle = Path()
        axle.move(to: CGPoint(x: cx, y: cy - ry - 4))
        axle.addLine(to: CGPoint(x: cx, y: cy - ry + 1))
        gc.stroke(axle, with: .color(.black.opacity(0.6)), lineWidth: 2)
    }
}

/// One sub-dial: a 270° gauge for a ratio, or a clock for the billing block.
private struct DialCell: View {
    let item: SignalsRibbon.Item

    var body: some View {
        VStack(spacing: 3) {
            Group {
                if item.id == "block" {
                    BlockDial(used: item.elapsed ?? max(0, min(1, 1 - Self.minutes(item.value) / 300)),
                              alert: item.alert, text: item.value)
                } else if let v = Self.percent(item.value) {
                    RatioDial(value: v, alert: item.alert, zone: zone, text: item.value)
                } else {
                    DrumWindow(reading: Reading(item.value), size: .small)
                        .frame(width: 58, height: 58)
                }
            }
            .frame(width: 58, height: 58)
            Engraved(item.label, size: 7, color: MeterSkin.Plate.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if let sub = item.sub {
                Text(sub)
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundColor(MeterSkin.Plate.muted)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
        }
        .frame(maxWidth: .infinity)
        .help(item.help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(item.label): \(item.value)\(item.sub.map { ", " + $0 } ?? "")")
    }

    /// The band where the reading needs attention — the same thresholds the
    /// other themes colour on (cache under 60% is danger, thinking over 80%
    /// is a warning). Other ratios get no zone rather than an invented one.
    private var zone: ClosedRange<Double>? {
        switch item.id {
        case "cache": return 0...0.60
        case "think": return 0.80...1
        default: return nil
        }
    }

    static func percent(_ value: String) -> Double? {
        guard value.hasSuffix("%"), let n = Double(value.dropLast()) else { return nil }
        return max(0, min(1, n / 100))
    }

    /// "4h57m" / "47m" → minutes.
    static func minutes(_ value: String) -> Double {
        var total = 0.0, number = ""
        for ch in value {
            if ch.isNumber { number.append(ch) }
            else if ch == "h" { total += (Double(number) ?? 0) * 60; number = "" }
            else if ch == "m" { total += Double(number) ?? 0; number = "" }
        }
        return total
    }
}

private struct RatioDial: View {
    let value: Double
    let alert: Color?
    let zone: ClosedRange<Double>?
    let text: String

    var body: some View {
        Canvas { gc, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = min(size.width, size.height) / 2 - 1
            DialFace.draw(gc, center: c, radius: r)
            let arcR = r * 0.74
            func angle(_ v: Double) -> Angle { .degrees(135 + 270 * v) }
            var scale = Path()
            scale.addArc(center: c, radius: arcR, startAngle: angle(0), endAngle: angle(1), clockwise: false)
            gc.stroke(scale, with: .color(MeterSkin.Plate.ink), lineWidth: 0.8)
            if let zone {
                var z = Path()
                z.addArc(center: c, radius: arcR, startAngle: angle(zone.lowerBound),
                         endAngle: angle(zone.upperBound), clockwise: false)
                gc.stroke(z, with: .color(MeterSkin.Plate.red), lineWidth: 3)
            }
            for i in 0...10 {
                let a = angle(Double(i) / 10).radians
                let inner = arcR - (i % 5 == 0 ? 5 : 3)
                var t = Path()
                t.move(to: CGPoint(x: c.x + cos(a) * inner, y: c.y + sin(a) * inner))
                t.addLine(to: CGPoint(x: c.x + cos(a) * arcR, y: c.y + sin(a) * arcR))
                gc.stroke(t, with: .color(MeterSkin.Plate.ink), lineWidth: i % 5 == 0 ? 1.1 : 0.7)
            }
            DialFace.needle(gc, center: c, length: arcR - 2, angle: angle(value),
                            color: alert ?? MeterSkin.Plate.ink)
            gc.draw(Text(text).font(.system(size: 9, weight: .medium, design: .monospaced))
                        .foregroundColor(alert ?? MeterSkin.Plate.ink),
                    at: CGPoint(x: c.x, y: c.y + r * 0.58))
        }
    }
}

/// The five-hour billing block as a clock dial. The hand points at the time
/// used; the arc from the hand round to twelve is what's left.
private struct BlockDial: View {
    let used: Double // fraction of the block elapsed, 0…1
    let alert: Color?
    let text: String

    var body: some View {
        Canvas { gc, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2)
            let r = min(size.width, size.height) / 2 - 1
            DialFace.draw(gc, center: c, radius: r)
            func angle(_ v: Double) -> Angle { .degrees(-90 + 360 * v) }
            var left = Path()
            left.addArc(center: c, radius: r * 0.8, startAngle: angle(used), endAngle: angle(1), clockwise: false)
            gc.stroke(left, with: .color((alert ?? MeterSkin.Plate.ink).opacity(alert == nil ? 0.55 : 1)), lineWidth: 2.5)
            for i in 0..<20 {
                let a = angle(Double(i) / 20).radians
                let major = i % 4 == 0
                var t = Path()
                t.move(to: CGPoint(x: c.x + cos(a) * (r - (major ? 6 : 3.5)), y: c.y + sin(a) * (r - (major ? 6 : 3.5))))
                t.addLine(to: CGPoint(x: c.x + cos(a) * (r - 1.5), y: c.y + sin(a) * (r - 1.5)))
                gc.stroke(t, with: .color(MeterSkin.Plate.ink), lineWidth: major ? 1.1 : 0.6)
            }
            DialFace.needle(gc, center: c, length: r * 0.68, angle: angle(used), color: MeterSkin.Plate.red)
            gc.draw(Text(text.replacingOccurrences(of: "m", with: ""))
                        .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                        .foregroundColor(alert ?? MeterSkin.Plate.ink),
                    at: CGPoint(x: c.x, y: c.y + r * 0.45))
        }
    }
}

private enum DialFace {
    static func draw(_ gc: GraphicsContext, center c: CGPoint, radius r: CGFloat) {
        let rect = CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)
        gc.fill(Path(ellipseIn: rect), with: .color(MeterSkin.Plate.dialFace))
        gc.stroke(Path(ellipseIn: rect.insetBy(dx: 0.6, dy: 0.6)), with: .color(MeterSkin.Plate.ink), lineWidth: 1.2)
    }

    static func needle(_ gc: GraphicsContext, center c: CGPoint, length: CGFloat, angle: Angle, color: Color) {
        let a = angle.radians
        var n = Path()
        n.move(to: CGPoint(x: c.x - cos(a) * 4, y: c.y - sin(a) * 4))
        n.addLine(to: CGPoint(x: c.x + cos(a) * length, y: c.y + sin(a) * length))
        gc.stroke(n, with: .color(color), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
        gc.fill(Path(ellipseIn: CGRect(x: c.x - 2.6, y: c.y - 2.6, width: 5.2, height: 5.2)),
                with: .color(MeterSkin.Plate.ink))
    }
}

/// One totalizer line: engraved name, drums, day change.
private struct LedgerLine: View {
    let row: LedgerRowData
    let theme: AppTheme

    private var unit: String {
        let u = Reading(row.value).unit
        switch row.id {
        case "tokens": return (u + " tok").trimmingCharacters(in: .whitespaces)
        case "cost": return (u + " USD").trimmingCharacters(in: .whitespaces)
        case "pace": return "× usual"
        case "streak": return "days"
        default: return u
        }
    }

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 1) {
                Engraved(row.name, size: 8.5, color: MeterSkin.Plate.ink)
                Text(row.note)
                    .font(.system(size: 8.5, design: .monospaced))
                    .foregroundColor(MeterSkin.Plate.muted)
                    .lineLimit(1)
            }
            .frame(width: 78, alignment: .leading)
            if row.isWarming {
                ShimmerBar(width: 64, height: 18, breathToggle: true)
            } else {
                DrumWindow(reading: Reading(row.value), size: .small, minCells: 3)
                    .modifier(SparklineUsageHover(days: row.sparkDays, theme: theme))
                Text(unit)
                    .font(.system(size: 9, weight: .bold).width(.expanded))
                    .foregroundColor(row.alert ?? MeterSkin.Plate.ink)
                    .lineLimit(1)
                if row.alert != nil {
                    Lamp(color: MeterSkin.Plate.ledAmber, on: true, size: 6)
                }
            }
            Spacer(minLength: 4)
            change
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var change: some View {
        if let trend = row.trend, !row.isWarming {
            let up = trend.percent >= 0
            Text("\(up ? "▲" : "▼") \(String(format: "%.1f", abs(trend.percent)))%")
                .font(.system(size: 11, weight: .medium, design: .monospaced))
                .foregroundColor(trend.metric == .cost && up ? theme.statusWarning : MeterSkin.Plate.ink)
                .lineLimit(1)
                .help(trend.description)
                .accessibilityLabel(trend.description)
        } else {
            Text("—")
                .font(.system(size: 11, design: .monospaced))
                .foregroundColor(MeterSkin.Plate.muted)
                .accessibilityHidden(true)
        }
    }
}

/// The service's state as an indicator lamp with an engraved legend.
private struct StatusLamp: View {
    @ObservedObject var loader: TokmeterLoader

    var body: some View {
        let (color, legend, help) = state
        HStack(spacing: 6) {
            Lamp(color: color, on: true, size: 8)
            Engraved(legend, size: 8, color: MeterSkin.Plate.ink)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .help(help)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(legend)
    }

    private var state: (Color, String, String) {
        switch loader.daemonPhase {
        case .warming:
            return (MeterSkin.Plate.ledAmber, "Warming up", "The usage service is reading your session logs.")
        case .needsNode:
            return (MeterSkin.Plate.ledRed, "Node.js required", "Install Node 18+ to run the local usage service.")
        case .offline:
            return (MeterSkin.Plate.ledRed, "Offline", "The usage service isn't running. Press ▶ Start below.")
        case .live:
            if loader.lastError != nil && loader.hasFreshData {
                return (MeterSkin.Plate.ledAmber, "Stale · last read failed",
                        "Showing the last good reading. \(loader.lastError ?? "")")
            }
            if let live = loader.statbarSignals?.liveSession {
                return (MeterSkin.Plate.ledGreen,
                        "Live · \(Fmt.projectBasename(live.project)) · \(Fmt.liveAge(live.ageSeconds))",
                        "Live: \(live.provider) · \(Fmt.shortModel(live.model)) · last call \(Fmt.cost(live.lastRecordCost))")
            }
            return (MeterSkin.Plate.ledGreen, "Live", "The usage service is running.")
        }
    }
}

private struct Lamp: View {
    let color: Color
    let on: Bool
    var size: CGFloat = 8

    var body: some View {
        Circle()
            .fill(RadialGradient(colors: [color.opacity(on ? 1 : 0.35), color.opacity(on ? 0.75 : 0.25)],
                                 center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: size))
            .overlay(Circle().strokeBorder(Color.black.opacity(0.45), lineWidth: 0.6))
            .frame(width: size, height: size)
            .shadow(color: on ? color.opacity(0.8) : .clear, radius: 3)
            .accessibilityHidden(true)
    }
}

/// Engraved plate lettering: wide, tracked capitals with a light lower lip.
private struct Engraved: View {
    let text: String
    var size: CGFloat = 9
    var color: Color = MeterSkin.Plate.engrave
    var mono = false

    init(_ text: String, size: CGFloat = 9, color: Color = MeterSkin.Plate.engrave, mono: Bool = false) {
        self.text = text
        self.size = size
        self.color = color
        self.mono = mono
    }

    var body: some View {
        Text(mono ? text : text.uppercased())
            .font(mono
                  ? .system(size: size, weight: .medium, design: .monospaced)
                  : .system(size: size, weight: .bold).width(.expanded))
            .tracking(mono ? 0.4 : size * 0.16)
            .foregroundColor(color)
            .shadow(color: .white.opacity(0.7), radius: 0, x: 0, y: 1)
    }
}

/// An engraved groove: a dark cut with a lit lower edge.
private struct Groove: View {
    var body: some View {
        VStack(spacing: 0) {
            Rectangle().fill(Color(red: 0.16, green: 0.17, blue: 0.19).opacity(0.45)).frame(height: 1)
            Rectangle().fill(Color.white.opacity(0.85)).frame(height: 1)
        }
        .accessibilityHidden(true)
    }
}

private struct Hairline: View {
    var body: some View {
        Rectangle().fill(Color(red: 0.16, green: 0.17, blue: 0.19).opacity(0.18)).frame(height: 1)
            .accessibilityHidden(true)
    }
}

/// A circuit's load: an engraved slot with a graphite bar.
private struct LoadBar: View {
    let share: Double

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.black.opacity(0.14))
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(Color.white.opacity(0.75)).frame(height: 0.8).offset(y: 0.8)
                    }
                RoundedRectangle(cornerRadius: 2)
                    .fill(LinearGradient(colors: [Color(red: 0.25, green: 0.26, blue: 0.28), MeterSkin.Plate.ink],
                                         startPoint: .top, endPoint: .bottom))
                    .frame(width: max(share > 0 ? 3 : 0, geo.size.width * share))
            }
        }
        .frame(height: 5)
        .accessibilityHidden(true)
    }
}

/// Black bakelite key face.
private struct BakeliteKey: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 4)
            .fill(LinearGradient(colors: [Color(red: 0.23, green: 0.235, blue: 0.247),
                                          Color(red: 0.07, green: 0.075, blue: 0.08)],
                                 startPoint: .top, endPoint: .bottom))
            .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Color.black, lineWidth: 1))
            .shadow(color: .black.opacity(0.9), radius: 0, x: 0, y: 1.5)
    }
}

/// The lead tamper seal on the totalizer.
private struct LeadSeal: View {
    var body: some View {
        Circle()
            .fill(RadialGradient(colors: [Color(white: 0.85), Color(white: 0.54), Color(white: 0.37)],
                                 center: UnitPoint(x: 0.35, y: 0.3), startRadius: 0, endRadius: 12))
            .overlay(Text("TM").font(.system(size: 6.5, weight: .bold, design: .monospaced))
                .foregroundColor(MeterSkin.Plate.ink))
            .frame(width: 18, height: 18)
            .help("Lifetime totals are sealed: past days in the ledger never shrink.")
            .accessibilityHidden(true)
    }
}

// MARK: - Load profile, tabs

/// The 7-day chart as a meter's load-profile register: a stepped trace of
/// cost per recorded day over a ruled baseline. The last step is today and
/// is still accumulating, so it's drawn in red with "so far". Bars and
/// area styles fill the steps; line draws the trace alone.
private struct LoadProfile: View {
    let days: [DailyUsage]
    let style: WeekChartStyle
    let theme: AppTheme

    @State private var hovered: Int?

    private static let todayKey: String = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date())
    }()

    private func weekday(_ date: String) -> String {
        let p = DateFormatter()
        p.locale = Locale(identifier: "en_US_POSIX")
        p.dateFormat = "yyyy-MM-dd"
        guard let d = p.date(from: date) else { return String(date.suffix(5)) }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "EEE"
        return f.string(from: d).uppercased()
    }

    var body: some View {
        let maxCost = max(days.map(\.cost).max() ?? 0, 0.01)
        let lastIsToday = days.last?.date == Self.todayKey
        VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                let w = geo.size.width, h = geo.size.height
                let n = max(days.count, 1)
                let step = w / CGFloat(n)
                let y: (Double) -> CGFloat = { h - 2 - CGFloat($0 / maxCost) * (h - 14) }
                ZStack(alignment: .topLeading) {
                    // Ruled register lines.
                    ForEach(1..<4) { i in
                        Rectangle().fill(MeterSkin.Plate.ink.opacity(0.10)).frame(height: 0.5)
                            .offset(y: h * CGFloat(i) / 4)
                    }
                    if style != .line {
                        ForEach(Array(days.enumerated()), id: \.offset) { i, day in
                            let isLast = i == days.count - 1
                            Rectangle()
                                .fill((isLast && lastIsToday ? MeterSkin.Plate.red : MeterSkin.Plate.ink)
                                    .opacity(style == .bars ? (hovered == i ? 0.95 : 0.80) : 0.16))
                                .frame(width: style == .bars ? step - 6 : step, height: max(1, h - 2 - y(day.cost)))
                                .offset(x: CGFloat(i) * step + (style == .bars ? 3 : 0), y: y(day.cost))
                        }
                    }
                    // The stepped trace.
                    Path { p in
                        for (i, day) in days.enumerated() {
                            let x0 = CGFloat(i) * step, x1 = x0 + step
                            if i == 0 { p.move(to: CGPoint(x: x0, y: h - 2)) }
                            p.addLine(to: CGPoint(x: x0, y: y(day.cost)))
                            p.addLine(to: CGPoint(x: x1, y: y(day.cost)))
                        }
                        p.addLine(to: CGPoint(x: CGFloat(days.count) * step, y: h - 2))
                    }
                    .stroke(MeterSkin.Plate.ink, style: StrokeStyle(lineWidth: style == .line ? 1.6 : 1.2, lineJoin: .miter))
                    if lastIsToday, let last = days.last {
                        Rectangle().fill(MeterSkin.Plate.red)
                            .frame(width: step, height: 2.5)
                            .offset(x: CGFloat(days.count - 1) * step, y: y(last.cost) - 1.25)
                        Text(Fmt.cost(last.cost) + " so far")
                            .font(.system(size: 8.5, weight: .medium, design: .monospaced))
                            .foregroundColor(MeterSkin.Plate.redInk)
                            .fixedSize()
                            .frame(width: step * 2, alignment: .trailing)
                            .offset(x: w - step * 2, y: max(0, y(last.cost) - 13))
                    }
                    // Baseline.
                    Rectangle().fill(MeterSkin.Plate.ink).frame(height: 1).offset(y: h - 1)
                    if let i = hovered {
                        Rectangle().fill(MeterSkin.Plate.ink.opacity(0.35)).frame(width: 1, height: h)
                            .offset(x: CGFloat(i) * step + step / 2)
                    }
                }
                .contentShape(Rectangle())
                .onContinuousHover { phase in
                    switch phase {
                    case .active(let pt):
                        let i = Int(pt.x / step)
                        hovered = days.indices.contains(i) ? i : nil
                    case .ended:
                        hovered = nil
                    }
                }
            }
            .frame(height: 58)
            .overlay(alignment: .topTrailing) {
                if let i = hovered, days.indices.contains(i) {
                    DailyUsageTooltip(day: days[i], theme: theme).offset(y: -36)
                }
            }
            HStack(spacing: 0) {
                ForEach(Array(days.enumerated()), id: \.offset) { i, day in
                    let isToday = i == days.count - 1 && lastIsToday
                    Text(isToday ? "TODAY" : weekday(day.date))
                        .font(.system(size: 8, weight: .medium, design: .monospaced))
                        .foregroundColor(isToday ? MeterSkin.Plate.redInk : MeterSkin.Plate.engrave)
                        .frame(maxWidth: .infinity)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Load profile, cost per recorded day: "
            + days.map { "\($0.date) \(Fmt.cost($0.cost))" }.joined(separator: ", ")
            + (lastIsToday ? ". Today is still accumulating." : ""))
    }
}

/// All / Today as notches on a rotary selector: the current position is
/// marked by a red pointer and set in ink.
private struct NotchTabs: View {
    @Binding var showToday: Bool

    var body: some View {
        HStack(spacing: 10) {
            notch("All", on: !showToday) { showToday = false }
            notch("Today", on: showToday) { showToday = true }
        }
    }

    private func notch(_ label: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            VStack(spacing: 2) {
                Triangle()
                    .fill(on ? MeterSkin.Plate.red : MeterSkin.Plate.ink.opacity(0.2))
                    .frame(width: 7, height: 4)
                Engraved(label, size: 8, color: on ? MeterSkin.Plate.ink : MeterSkin.Plate.muted)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityAddTraits(on ? .isSelected : [])
    }

    private struct Triangle: Shape {
        func path(in r: CGRect) -> Path {
            Path { p in
                p.move(to: CGPoint(x: r.minX, y: r.minY))
                p.addLine(to: CGPoint(x: r.maxX, y: r.minY))
                p.addLine(to: CGPoint(x: r.midX, y: r.maxY))
                p.closeSubpath()
            }
        }
    }
}
