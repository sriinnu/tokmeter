// HubSidebar.swift — the hub's left navigation column.
//
// Not just a nav list: an ambient dashboard. Top to bottom — brand + live
// daemon-connection dot, a "Today" card (live cost / burn / cache / a pulse
// when a session is running), a grouped EXPLORE nav with a springy selection
// rail and ⌘1–⌘4 shortcuts, Settings pinned to the bottom, and a footer that
// states the real daemon connection status. Animations keep the pixar-springy
// sensibility: the selection rail slides between rows with a real overshoot,
// the live dot breathes, rows lift on hover.

import SwiftUI

struct HubSidebar: View {
    @Binding var selection: HubSection
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    /// Shared namespace so the accent selection rail can slide between rows
    /// instead of cross-fading — the signature "one indicator, many homes" move.
    @Namespace private var railNS

    /// Drives the warming-skeleton shimmer breath.
    @State private var breathe = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    /// The exploration trio. Settings is pinned to the bottom on its own —
    /// configuring the app is a different mental mode than exploring data.
    private let primary: [HubSection] = [.overview, .projects, .commands]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            brand
                .padding(.horizontal, 16)
                .padding(.top, 18)

            todayCard
                .padding(.horizontal, 12)
                .padding(.top, 14)
                .cascadeIn(delay: 0.05)

            groupLabel("EXPLORE")
                .padding(.horizontal, theme == .paper ? 16 : 22)
                .padding(.top, 20)
                .padding(.bottom, 4)

            VStack(spacing: theme == .paper ? 0 : 3) {
                ForEach(Array(primary.enumerated()), id: \.element.id) { idx, section in
                    HubSidebarRow(
                        section: section,
                        theme: theme,
                        badge: badge(for: section),
                        shortcutNumber: idx + 1,
                        isSelected: selection == section,
                        railNS: railNS
                    ) { select(section) }
                        .cascadeIn(delay: 0.12 + Double(idx) * 0.05)
                }
            }
            .padding(.horizontal, theme == .paper ? 16 : 10)

            Spacer(minLength: 16)

            HubSidebarRow(
                section: .settings,
                theme: theme,
                badge: nil,
                shortcutNumber: 4,
                isSelected: selection == .settings,
                railNS: railNS
            ) { select(.settings) }
                .padding(.horizontal, theme == .paper ? 16 : 10)

            if theme == .paper {
                InkRule(weight: 1)
                    .padding(.horizontal, 16)
                    .padding(.top, 10)
            } else {
                Divider()
                    .opacity(0.16)
                    .padding(.horizontal, 14)
                    .padding(.top, 10)
            }

            footer
                .padding(.horizontal, 16)
                .padding(.top, 10)
                .padding(.bottom, 12)
        }
        // Cap at the pinned column width so sidebar content can never report a
        // width wider than the fixed 232pt column (no intrinsic-width feedback
        // into the split divider). See HubView's column pin.
        .frame(maxWidth: 232, alignment: .leading)
        .onAppear { breathe = true }
    }

    private func select(_ section: HubSection) {
        guard selection != section else { return }
        // Panel swap is a structural change (whole detail subtree replaced). Do NOT
        // wrap it in withAnimation — animating a structural change re-enters the
        // window's Update-Constraints pass and crashes ("more Update Constraints
        // passes than there are views in the window"). This is the actual sidebar
        // click path. Instant swap; each panel still fades in via cascadeIn.
        selection = section
    }

    private func badge(for section: HubSection) -> String? {
        switch section {
        case .projects:
            let n = loader.stats?.projects ?? loader.sessions.count
            return n > 0 ? "\(n)" : nil
        default:
            return nil
        }
    }

    // MARK: - Brand mark

    @ViewBuilder
    private var brand: some View {
        if theme.skin != nil {
            skinBrand
        } else if theme == .paper {
            paperBrand
        } else {
            standardBrand
        }
    }

    /// Paper: a small nameplate. Dateline, rule, "The Tokmeter", double rule.
    private var paperBrand: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 6) {
                Kicker(text: "Hub")
                Text("·").font(Broadsheet.kickerFont).foregroundColor(Broadsheet.muted)
                Kicker(text: BroadsheetDateline.date(), color: Broadsheet.muted)
                    .lineLimit(1)
                    .fixedSize()
                Spacer(minLength: 0)
                ConnectionDot(status: connection, theme: theme)
            }
            InkRule(weight: 0.5)
            Text("The Tokmeter")
                .font(Broadsheet.display(24))
                .foregroundColor(Broadsheet.ink)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .center)
            DoubleRule()
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tokmeter Hub, \(connection.label)")
    }

    /// Skins: the skin's name set as a nameplate in its hero face.
    private var skinBrand: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("TOKMETER")
                    .font(theme.fonts.hero(size: 19))
                    .tracking(1.2)
                    .foregroundColor(bg.primaryTextColor)
                    .lineLimit(1)
                Text("HUB · \(theme.displayName.uppercased())")
                    .font(theme.fonts.label(size: 9, weight: .heavy))
                    .tracking(1.6)
                    .foregroundColor(c.accent)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
            ConnectionDot(status: connection, theme: theme)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Tokmeter Hub, \(connection.label)")
    }

    /// Skins: today's figures on the skin's own card, in its faces.
    @ViewBuilder
    private var skinTodayCard: some View {
        let warming = loader.isWarming || !loader.hasFreshData
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                HubSkinLabel(text: "Today", theme: theme)
                Spacer(minLength: 0)
                if let live = loader.liveSession {
                    HStack(spacing: 4) {
                        PulseDot(color: theme.statusSuccess)
                        HubSkinLabel(text: Fmt.liveAge(live.ageSeconds), theme: theme,
                                     color: bg.primaryTextColor)
                    }
                }
            }
            if warming {
                shimmerLine(width: 92, height: 22)
                shimmerLine(width: 120, height: 11)
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    HubSkinFigure(value: Fmt.number(loader.todayTokens), size: 24, theme: theme)
                    Text("tokens")
                        .font(theme.fonts.body(size: 11))
                        .foregroundColor(bg.secondaryTextColor)
                }
                HStack(alignment: .firstTextBaseline, spacing: 5) {
                    HubSkinFigure(
                        value: loader.statbarSignals?.costBasisToday.flatMap { basis in
                            basis.estimatedRecords > 0 ? Fmt.cost(basis.estimatedCost) : nil
                        } ?? "—",
                        size: 22, theme: theme, money: true)
                    Text("est. API cost")
                        .font(theme.fonts.body(size: 10.5))
                        .foregroundColor(bg.secondaryTextColor)
                        .help("Usage valued at model API rates. The overview's Today cost also includes tool reports.")
                }
                if !paperFacts.isEmpty {
                    HubSkinLabel(text: paperFacts.joined(separator: " · "), theme: theme)
                }
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background { if let skin = theme.skin { SkinCard(skin: skin, role: c.accent) } }
    }

    private var standardBrand: some View {
        HStack(spacing: 9) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: theme.selectedFill,
                            startPoint: .topLeading, endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 30, height: 30)
                    .shadow(color: c.primary.opacity(0.35), radius: 6, y: 2)
                Image(systemName: "infinity")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(theme.onSelectedInk)
            }
            VStack(alignment: .leading, spacing: 0) {
                Text("Tokmeter")
                    .font(.system(size: 14, weight: .bold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("Hub")
                    .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(c.accent)
                    .tracking(1.5)
            }
            Spacer(minLength: 0)
            ConnectionDot(status: connection, theme: theme)
        }
    }

    // MARK: - Today card

    @ViewBuilder
    private var todayCard: some View {
        if theme.skin != nil {
            skinTodayCard
        } else if theme == .paper {
            paperTodayCard
        } else {
            standardTodayCard
        }
    }

    /// Paper: the front-page box. Kicker, two serif figures, a footnote and
    /// the day's signals as plain tracked capitals, closed by a rule.
    @ViewBuilder
    private var paperTodayCard: some View {
        let warming = loader.isWarming || !loader.hasFreshData
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Kicker(text: "Today", inverted: true)
                Spacer(minLength: 0)
                if let live = loader.liveSession {
                    HStack(spacing: 4) {
                        PulseDot(color: theme.statusSuccess)
                        Kicker(text: "Live · " + Fmt.liveAge(live.ageSeconds), color: Broadsheet.ink)
                    }
                    .transition(.opacity)
                }
            }
            if warming {
                shimmerLine(width: 92, height: 22)
                shimmerLine(width: 120, height: 11)
            } else {
                (Text(Fmt.number(loader.todayTokens))
                    .font(Broadsheet.display(30))
                    .monospacedDigit()
                    .foregroundColor(Broadsheet.ink)
                + Text(" tokens")
                    .font(.system(size: 13, weight: .semibold, design: .serif))
                    .foregroundColor(Broadsheet.muted))
                    .lineLimit(1)
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Text("Est. API cost")
                        .font(.system(size: 11, design: .serif))
                        .italic()
                        .foregroundColor(Broadsheet.muted)
                    LeaderDots()
                    Text(loader.statbarSignals?.costBasisToday.flatMap { basis in
                        basis.estimatedRecords > 0 ? Fmt.cost(basis.estimatedCost) : nil
                    } ?? "—")
                        .font(Broadsheet.display(20, weight: .bold))
                        .monospacedDigit()
                        .foregroundColor(Broadsheet.ink)
                        .contentTransition(.numericText())
                        .lineLimit(1)
                }
                .help("Usage valued at model API rates. The overview's Today cost also includes tool reports.")
                let facts = paperFacts
                if !facts.isEmpty {
                    Kicker(text: facts.joined(separator: " · "), color: Broadsheet.ink2)
                        .lineLimit(1)
                }
            }
            InkRule(weight: 1).padding(.top, 2)
        }
        .padding(.horizontal, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var paperFacts: [String] {
        var facts: [String] = []
        if let burn = loader.statbarSignals?.burnRate.costPerHour, burn >= 0.01 {
            facts.append("Burn " + Fmt.costPerHour(burn))
        }
        if let cache = loader.statbarSignals?.cacheHitToday.canonicalRate, cache > 0 {
            facts.append("Cache \(Int((cache * 100).rounded()))%")
        }
        return facts
    }

    @ViewBuilder
    private var standardTodayCard: some View {
        let warming = loader.isWarming || !loader.hasFreshData
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text("TODAY")
                    .font(.system(size: 9, weight: .bold, design: theme.fonts.labelDesign))
                    .tracking(1.6)
                    .foregroundColor(bg.secondaryTextColor)
                Spacer(minLength: 0)
                if let live = loader.liveSession {
                    HStack(spacing: 4) {
                        PulseDot(color: theme.statusSuccess)
                        Text(Fmt.liveAge(live.ageSeconds))
                            .font(.system(size: 9, weight: .semibold, design: theme.fonts.bodyDesign))
                            .foregroundColor(theme.statusSuccess)
                    }
                    .transition(.opacity)
                }
            }

            if warming {
                shimmerLine(width: 92, height: 22)
                shimmerLine(width: 120, height: 11)
            } else {
                Text("\(Fmt.number(loader.todayTokens)) tokens")
                    .font(.system(size: 22, weight: .bold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
                    .lineLimit(1)
                Text(loader.statbarSignals?.costBasisToday.flatMap { basis in
                    basis.estimatedRecords > 0 ? Fmt.cost(basis.estimatedCost) : nil
                } ?? "—")
                    .font(.system(size: 24, weight: .heavy, design: theme.fonts.labelDesign))
                    .foregroundColor(theme.costInk)
                    .contentTransition(.numericText())
                    // Single-pass text only. minimumScaleFactor is a TWO-pass
                    // intrinsic-width measurement; on the 30s data poll it re-reports
                    // a different width and, inside the split column, re-dirties the
                    // window's constraint pass — a prime driver of the delayed crash.
                    .lineLimit(1)
                    .truncationMode(.tail)
                Text("Estimated API cost today")
                    .font(.system(size: 10, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .help("Usage valued at model API rates. The overview's Today cost also includes tool reports.")

                HStack(spacing: 6) {
                    if let burn = loader.statbarSignals?.burnRate.costPerHour, burn >= 0.01 {
                        miniPill(
                            icon: "flame.fill",
                            text: Fmt.costPerHour(burn),
                            tint: theme.burnRateColor(burn)
                        )
                    }
                    if let cache = loader.statbarSignals?.cacheHitToday.canonicalRate, cache > 0 {
                        miniPill(
                            icon: "bolt.horizontal.fill",
                            text: "\(Int((cache * 100).rounded()))%",
                            tint: cache >= 0.9 ? theme.statusSuccess : (cache >= 0.6 ? theme.statusWarning : theme.statusDanger)
                        )
                    }
                }
            }
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 13, style: .continuous)
                .fill(Color.primary.opacity(bg.isLight ? 0.04 : 0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: 13, style: .continuous)
                        .stroke(c.accent.opacity(0.14), lineWidth: 1)
                )
        )
    }

    private func miniPill(icon: String, text: String, tint: Color) -> some View {
        HStack(spacing: 3) {
            Image(systemName: icon).font(.system(size: 8, weight: .bold))
            Text(text)
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.bodyDesign))
        }
        .foregroundColor(tint)
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(tint.opacity(0.14)))
    }

    private func shimmerLine(width: CGFloat, height: CGFloat) -> some View {
        ShimmerBar(width: width, height: height, breathToggle: breathe)
    }

    // MARK: - Group label

    @ViewBuilder
    private func groupLabel(_ text: String) -> some View {
        if theme.skin != nil {
            HubSkinLabel(text: text, theme: theme)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if theme == .paper {
            HubPaperLabel(text: text)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else {
            standardGroupLabel(text)
        }
    }

    private func standardGroupLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: theme.fonts.labelDesign))
            .tracking(1.8)
            .foregroundColor(bg.secondaryTextColor.opacity(0.8))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Footer

    @ViewBuilder
    private var footer: some View {
        if theme.skin != nil {
            HStack(spacing: 6) {
                Circle()
                    .fill(connection.color(theme: theme))
                    .frame(width: 6, height: 6)
                HubSkinLabel(text: connection.label, theme: theme, color: bg.primaryTextColor)
                Spacer(minLength: 0)
                HubSkinLabel(text: "v\(appVersion)", theme: theme)
            }
        } else if theme == .paper {
            HStack(spacing: 6) {
                Circle()
                    .fill(connection.color(theme: theme))
                    .frame(width: 6, height: 6)
                Kicker(text: connection.label, color: Broadsheet.ink)
                Spacer(minLength: 0)
                Kicker(text: "v\(appVersion)", color: Broadsheet.muted)
            }
        } else {
            standardFooter
        }
    }

    private var standardFooter: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connection.color(theme: theme))
                .frame(width: 6, height: 6)
            Text(connection.label)
                .font(.system(size: 10, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
            Spacer(minLength: 0)
            Text("v\(appVersion)")
                .font(.system(size: 9, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor.opacity(0.7))
        }
    }

    // MARK: - Derived connection state

    private var connection: ConnectionStatus {
        if !loader.isDaemonAlive { return .offline }
        if loader.isWarming || !loader.hasFreshData { return .warming }
        return .live
    }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

// MARK: - Connection status

enum ConnectionStatus {
    case live, warming, offline

    func color(theme: AppTheme) -> Color {
        switch self {
        case .live: return theme.statusSuccess
        case .warming: return theme.statusWarning
        case .offline: return theme.statusDanger
        }
    }

    var label: String {
        switch self {
        case .live: return "Connected"
        case .warming: return "Warming up…"
        case .offline: return "Daemon offline"
        }
    }

    var pulses: Bool { self == .live }
}

/// Brand-corner connection dot. Breathes when live, steady otherwise.
struct ConnectionDot: View {
    let status: ConnectionStatus
    let theme: AppTheme
    @State private var pulse = false

    var body: some View {
        ZStack {
            if status.pulses {
                Circle()
                    .stroke(status.color(theme: theme).opacity(0.5), lineWidth: 1.5)
                    .frame(width: 14, height: 14)
                    .scaleEffect(pulse ? 1.6 : 1.0)
                    .opacity(pulse ? 0 : 0.8)
            }
            Circle()
                .fill(status.color(theme: theme))
                .frame(width: 8, height: 8)
                .shadow(color: status.color(theme: theme).opacity(0.6), radius: pulse ? 4 : 2)
        }
        .help(status.label)
        .onAppear {
            guard status.pulses else { return }
            withAnimation(.easeOut(duration: 1.4).repeatForever(autoreverses: false)) {
                pulse = true
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.7), value: status)
    }
}

/// Small steady-breathing dot for the "live session" indicator.
struct PulseDot: View {
    let color: Color
    @State private var on = false

    var body: some View {
        Circle()
            .fill(color)
            .frame(width: 6, height: 6)
            .opacity(on ? 1.0 : 0.4)
            .onAppear {
                withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) {
                    on = true
                }
            }
    }
}

// MARK: - Row

/// One sidebar row. Owns its hover state so only the hovered/selected row
/// re-renders. Carries the leading selection rail (matchedGeometryEffect),
/// an optional trailing count badge, and a ⌘N keycap that fades in on hover.
struct HubSidebarRow: View {
    let section: HubSection
    let theme: AppTheme
    let badge: String?
    let shortcutNumber: Int
    let isSelected: Bool
    let railNS: Namespace.ID
    let onTap: () -> Void

    @State private var hovered = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        if theme.skin != nil {
            skinBody
        } else if theme == .paper {
            paperBody
        } else {
            standardBody
        }
    }

    /// Skins: the section name in the skin's face. The selected row sits on
    /// the skin's card with an accent bar; no icon tiles.
    private var skinBody: some View {
        Button(action: onTap) {
            HStack(spacing: 9) {
                Rectangle()
                    .fill(isSelected ? c.accent : Color.clear)
                    .frame(width: 3, height: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(section.title)
                        .font(theme.fonts.label(size: 13, weight: isSelected ? .bold : .medium))
                        .foregroundColor(bg.primaryTextColor.opacity(isSelected ? 1 : 0.82))
                    if isSelected {
                        Text(section.tagline)
                            .font(theme.fonts.body(size: 9.5))
                            .foregroundColor(bg.secondaryTextColor)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                if let badge {
                    HubSkinLabel(text: badge, theme: theme, color: bg.primaryTextColor)
                } else if hovered && !isSelected {
                    HubSkinLabel(text: "⌘\(shortcutNumber)", theme: theme)
                }
            }
            .padding(.vertical, 7)
            .padding(.trailing, 8)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                if isSelected, let skin = theme.skin {
                    SkinCard(skin: skin, role: c.accent)
                } else if hovered {
                    RoundedRectangle(cornerRadius: 4).fill(bg.primaryTextColor.opacity(0.05))
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .keyboardShortcut(KeyEquivalent(Character("\(shortcutNumber)")), modifiers: .command)
        .onHover { hovered = $0 }
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    /// Paper: a contents line. Serif title over a hairline; the selected
    /// section is set in reverse, like an inverted kicker.
    private var paperBody: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(section.title)
                            .font(.system(size: 15, weight: isSelected ? .bold : .semibold, design: .serif))
                        if isSelected {
                            Text(section.tagline)
                                .font(.system(size: 10.5, design: .serif))
                                .italic()
                                .opacity(0.8)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if let badge {
                        Text(badge)
                            .font(Broadsheet.kickerFont)
                            .tracking(Broadsheet.kickerTracking)
                            .monospacedDigit()
                            .opacity(0.75)
                    } else if hovered && !isSelected {
                        Text("⌘\(shortcutNumber)")
                            .font(Broadsheet.kickerFont)
                            .foregroundColor(Broadsheet.muted)
                    }
                }
                .foregroundColor(isSelected ? Broadsheet.stock : Broadsheet.ink)
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(isSelected ? Broadsheet.ink : (hovered ? Broadsheet.ink.opacity(0.06) : Color.clear))
                InkRule(weight: 0.5, color: Broadsheet.ink.opacity(isSelected ? 0 : 0.35))
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
        .keyboardShortcut(
            KeyEquivalent(Character("\(shortcutNumber)")), modifiers: .command
        )
        .onHover { hovered = $0 }
        .accessibilityLabel(section.title)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var standardBody: some View {
        Button(action: onTap) {
            HStack(spacing: 10) {
                // Leading selection rail — slides between rows with a spring.
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.clear).frame(width: 3, height: 18)
                    if isSelected {
                        Capsule()
                            .fill(
                                LinearGradient(
                                    colors: [c.primary, c.secondary],
                                    startPoint: .top, endPoint: .bottom
                                )
                            )
                            .frame(width: 3, height: 18)
                            .matchedGeometryEffect(id: "selectionRail", in: railNS)
                    }
                }

                // Icon tile
                ZStack {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(
                            isSelected
                                ? AnyShapeStyle(
                                    LinearGradient(
                                        colors: theme.selectedFill.map { $0.opacity(0.9) },
                                        startPoint: .topLeading, endPoint: .bottomTrailing
                                    )
                                )
                                : AnyShapeStyle(Color.primary.opacity(hovered ? 0.10 : 0.05))
                        )
                        .frame(width: 30, height: 30)
                    Image(systemName: section.icon)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(isSelected ? theme.onSelectedInk : bg.primaryTextColor.opacity(0.7))
                        .scaleEffect(isSelected ? 1.0 : 0.92)
                }

                VStack(alignment: .leading, spacing: 1) {
                    Text(section.title)
                        .font(.system(size: 12.5,
                                      weight: isSelected ? .semibold : .medium,
                                      design: theme.fonts.labelDesign))
                        .foregroundColor(
                            isSelected ? bg.primaryTextColor : bg.primaryTextColor.opacity(0.8)
                        )
                    // Tagline only on the active row — keeps idle rows clean,
                    // gives the selected one a touch of context.
                    if isSelected {
                        Text(section.tagline)
                            .font(.system(size: 9, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.secondaryTextColor)
                            .lineLimit(1)
                            .transition(.opacity.combined(with: .move(edge: .top)))
                    }
                }

                Spacer(minLength: 0)

                trailing
            }
            .padding(.horizontal, 8)
            .padding(.vertical, 7)
            .background(
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(rowFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: 11, style: .continuous)
                            .stroke(isSelected ? c.accent.opacity(0.30) : Color.clear, lineWidth: 1)
                    )
            )
            .scaleEffect(hovered && !isSelected ? 1.015 : 1.0)
            .offset(y: hovered && !isSelected ? -1 : 0)
        }
        .buttonStyle(.borderless)
        .keyboardShortcut(
            KeyEquivalent(Character("\(shortcutNumber)")), modifiers: .command
        )
        .contentShape(Rectangle())
        .onHover { hovered = $0 }
        .animation(.spring(response: 0.42, dampingFraction: 0.66), value: isSelected)
        .animation(.spring(response: 0.3, dampingFraction: 0.72), value: hovered)
    }

    private var rowFill: Color {
        if isSelected { return c.accent.opacity(0.12) }
        if hovered { return Color.primary.opacity(0.05) }
        return .clear
    }

    /// Trailing slot: a live count badge when present, otherwise a ⌘N keycap
    /// that only appears on hover so the resting state stays calm.
    @ViewBuilder
    private var trailing: some View {
        if let badge {
            Text(badge)
                .font(.system(size: 9, weight: .bold, design: theme.fonts.bodyDesign))
                .foregroundColor(isSelected ? c.accent : bg.secondaryTextColor)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    Capsule().fill(
                        (isSelected ? c.accent : bg.secondaryTextColor).opacity(0.15)
                    )
                )
        } else if hovered && !isSelected {
            Text("⌘\(shortcutNumber)")
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundColor(bg.secondaryTextColor.opacity(0.7))
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(
                    RoundedRectangle(cornerRadius: 5, style: .continuous)
                        .fill(Color.primary.opacity(0.06))
                )
                .transition(.opacity)
        }
    }
}
