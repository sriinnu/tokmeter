// Skins.swift — themes that change the metaphor, not just the chrome.
//
// Paper and Terminal grew their bespoke views one `if theme == .paper` at a
// time. Skins get the same depth through fixed hook points instead, so each
// skin lives in one file (Skin+<Name>.swift) and never edits shared views:
//
//   Hero          the whole masthead / front-panel (gets the HeroHeader, so
//                 it can reuse its states: warming, offline, cost basis)
//   Signals       the "right now" readings (burn, cache, drag, think, block)
//   Ledger        the all-time rows (tokens, cost, pace)
//   SectionHead   "TODAY'S MODELS 2"
//   ModelRow      one model with its cost share
//   ProjectRow    one project with tokens and cost
//   Card          the background behind a card-mode surface
//
// Static personality (palette, surface, type) comes from `SkinSpec`.

import SwiftUI

enum Skin: String, CaseIterable {
    case meter, pump, rams, deck, passbook

    var spec: any SkinSpec.Type {
        switch self {
        case .meter: return MeterSkin.self
        case .pump: return PumpSkin.self
        case .rams: return RamsSkin.self
        case .deck: return DeckSkin.self
        case .passbook: return PassbookSkin.self
        }
    }
}

protocol SkinSpec {
    static var displayName: String { get }
    static var tagline: String { get }
    /// SF Symbol for the picker swatch.
    static var icon: String { get }
    static var palette: ThemeColors { get }
    /// Flat popover surface. Also used by the Settings sheet and the Hub.
    static var surface: Color { get }
    static var isLight: Bool { get }
    /// Outer background gradient; return `[surface, surface]` for flat.
    static var gradient: [Color] { get }
    static var fonts: ThemeFonts { get }
    /// Opaque ink for money, ≥4.5:1 on `surface`.
    static var costInk: Color { get }
    static var cornerRadius: CGFloat { get }

    // Chart, tabs, disclosure and footnote: return nil to keep the shared
    // view. Required, not defaulted, so a mistyped signature is a compile
    // error instead of a silent fall-back to the generic look.

    /// The 7-day chart body (the section head stays shared). `days` is
    /// oldest→newest recorded days. The last one is NOT necessarily today:
    /// only a day whose date equals today's local date is still
    /// accumulating, so compare dates before marking anything "today".
    @MainActor static func weekChart(days: [DailyUsage], style: WeekChartStyle, theme: AppTheme) -> AnyView?
    /// The All / Today switch in the models header.
    @MainActor static func modelTabs(showToday: Binding<Bool>, theme: AppTheme) -> AnyView?
    /// The "Usage details" disclosure row's label, chevron included.
    @MainActor static func disclosureLabel(expanded: Bool, theme: AppTheme) -> AnyView?
    /// The cost-basis footnote under the projects.
    @MainActor static func footnote(_ text: String, theme: AppTheme) -> AnyView?
}

extension AppTheme {
    var skin: Skin? {
        switch self {
        case .meter: return .meter
        case .pump: return .pump
        case .rams: return .rams
        case .deck: return .deck
        case .passbook: return .passbook
        default: return nil
        }
    }
}

// MARK: - Hook data

/// One all-time ledger row, computed once by StatsGrid.
struct LedgerRowData: Identifiable {
    let id: String
    let name: String
    let note: String
    let value: String
    /// Non-nil only when the reading needs attention (hot pace).
    var alert: Color? = nil
    let trend: RecordedDayTrend?
    let spark: [Double]
    let sparkDays: [DailyUsage]
    let isWarming: Bool
}

/// One model row, computed by ModelsSection.
struct ModelRowData {
    let model: ModelUsage
    let name: String
    /// Provider, shown only when two providers serve the same model name.
    let provider: String?
    /// Cost relative to the costliest row, 0…1.
    let share: Double
    /// No priceable usage: show "n/a", not $0.00.
    let activityOnly: Bool
    /// Tooltip with tokens, cost and token mix.
    let help: String
}

// MARK: - Dispatch

struct SkinHero: View {
    let skin: Skin
    let header: HeroHeader

    var body: some View {
        switch skin {
        case .meter: MeterSkin.Hero(header: header)
        case .pump: PumpSkin.Hero(header: header)
        case .rams: RamsSkin.Hero(header: header)
        case .deck: DeckSkin.Hero(header: header)
        case .passbook: PassbookSkin.Hero(header: header)
        }
    }
}

struct SkinSignals: View {
    let skin: Skin
    let items: [SignalsRibbon.Item]
    let theme: AppTheme

    var body: some View {
        switch skin {
        case .meter: MeterSkin.Signals(items: items, theme: theme)
        case .pump: PumpSkin.Signals(items: items, theme: theme)
        case .rams: RamsSkin.Signals(items: items, theme: theme)
        case .deck: DeckSkin.Signals(items: items, theme: theme)
        case .passbook: PassbookSkin.Signals(items: items, theme: theme)
        }
    }
}

struct SkinLedger: View {
    let skin: Skin
    let rows: [LedgerRowData]
    let theme: AppTheme

    var body: some View {
        switch skin {
        case .meter: MeterSkin.Ledger(rows: rows, theme: theme)
        case .pump: PumpSkin.Ledger(rows: rows, theme: theme)
        case .rams: RamsSkin.Ledger(rows: rows, theme: theme)
        case .deck: DeckSkin.Ledger(rows: rows, theme: theme)
        case .passbook: PassbookSkin.Ledger(rows: rows, theme: theme)
        }
    }
}

struct SkinSectionHead: View {
    let skin: Skin
    let label: String
    let count: Int
    let theme: AppTheme

    var body: some View {
        switch skin {
        case .meter: MeterSkin.SectionHead(label: label, count: count, theme: theme)
        case .pump: PumpSkin.SectionHead(label: label, count: count, theme: theme)
        case .rams: RamsSkin.SectionHead(label: label, count: count, theme: theme)
        case .deck: DeckSkin.SectionHead(label: label, count: count, theme: theme)
        case .passbook: PassbookSkin.SectionHead(label: label, count: count, theme: theme)
        }
    }
}

struct SkinModelRow: View {
    let skin: Skin
    let row: ModelRowData
    let theme: AppTheme

    var body: some View {
        switch skin {
        case .meter: MeterSkin.ModelRow(row: row, theme: theme)
        case .pump: PumpSkin.ModelRow(row: row, theme: theme)
        case .rams: RamsSkin.ModelRow(row: row, theme: theme)
        case .deck: DeckSkin.ModelRow(row: row, theme: theme)
        case .passbook: PassbookSkin.ModelRow(row: row, theme: theme)
        }
    }
}

struct SkinProjectRow: View {
    let skin: Skin
    let project: ProjectData
    let theme: AppTheme

    var body: some View {
        switch skin {
        case .meter: MeterSkin.ProjectRow(project: project, theme: theme)
        case .pump: PumpSkin.ProjectRow(project: project, theme: theme)
        case .rams: RamsSkin.ProjectRow(project: project, theme: theme)
        case .deck: DeckSkin.ProjectRow(project: project, theme: theme)
        case .passbook: PassbookSkin.ProjectRow(project: project, theme: theme)
        }
    }
}

struct SkinCard: View {
    let skin: Skin
    let role: Color

    var body: some View {
        switch skin {
        case .meter: MeterSkin.Card(role: role)
        case .pump: PumpSkin.Card(role: role)
        case .rams: RamsSkin.Card(role: role)
        case .deck: DeckSkin.Card(role: role)
        case .passbook: PassbookSkin.Card(role: role)
        }
    }
}
