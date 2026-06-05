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
                .padding(.horizontal, 22)
                .padding(.top, 20)
                .padding(.bottom, 4)

            VStack(spacing: 3) {
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
            .padding(.horizontal, 10)

            Spacer(minLength: 12)

            HubSidebarRow(
                section: .settings,
                theme: theme,
                badge: nil,
                shortcutNumber: 4,
                isSelected: selection == .settings,
                railNS: railNS
            ) { select(.settings) }
                .padding(.horizontal, 10)

            Divider()
                .opacity(0.16)
                .padding(.horizontal, 14)
                .padding(.top, 10)

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

    private var brand: some View {
        HStack(spacing: 9) {
            ZStack {
                RoundedRectangle(cornerRadius: 9, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [c.primary, c.secondary],
                            startPoint: .topLeading, endPoint: .bottomTrailing
                        )
                    )
                    .frame(width: 30, height: 30)
                    .shadow(color: c.primary.opacity(0.35), radius: 6, y: 2)
                Image(systemName: "infinity")
                    .font(.system(size: 15, weight: .bold))
                    .foregroundStyle(.white)
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
        let warming = loader.isWarming || !loader.hasFreshData
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 6) {
                Text("TODAY")
                    .font(.system(size: 9, weight: .bold, design: theme.fonts.labelDesign))
                    .tracking(1.6)
                    .foregroundColor(bg.secondaryTextColor)
                Spacer(minLength: 0)
                if let live = loader.statbarSignals?.liveSession {
                    HStack(spacing: 4) {
                        PulseDot(color: .tokSuccess)
                        Text(Fmt.liveAge(live.ageSeconds))
                            .font(.system(size: 9, weight: .semibold, design: theme.fonts.bodyDesign))
                            .foregroundColor(.tokSuccess)
                    }
                    .transition(.opacity)
                }
            }

            if warming {
                shimmerLine(width: 92, height: 22)
                shimmerLine(width: 120, height: 11)
            } else {
                Text(Fmt.cost(loader.todayCost))
                    .font(.system(size: 24, weight: .heavy, design: theme.fonts.labelDesign))
                    .foregroundColor(c.highlight)
                    .contentTransition(.numericText())
                    // Single-pass text only. minimumScaleFactor is a TWO-pass
                    // intrinsic-width measurement; on the 30s data poll it re-reports
                    // a different width and, inside the split column, re-dirties the
                    // window's constraint pass — a prime driver of the delayed crash.
                    .lineLimit(1)
                    .truncationMode(.tail)

                HStack(spacing: 6) {
                    if let burn = loader.statbarSignals?.burnRate.costPerHour, burn >= 0.01 {
                        miniPill(
                            icon: "flame.fill",
                            text: Fmt.costPerHour(burn),
                            tint: c.warm
                        )
                    }
                    if let cache = loader.statbarSignals?.cacheHitToday.canonicalRate, cache > 0 {
                        miniPill(
                            icon: "bolt.horizontal.fill",
                            text: "\(Int((cache * 100).rounded()))%",
                            tint: cache >= 0.9 ? .tokSuccess : (cache >= 0.6 ? .tokWarning : .tokDanger)
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

    private func groupLabel(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .bold, design: theme.fonts.labelDesign))
            .tracking(1.8)
            .foregroundColor(bg.secondaryTextColor.opacity(0.8))
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connection.color)
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

    var color: Color {
        switch self {
        case .live: return .tokSuccess
        case .warming: return .tokWarning
        case .offline: return .tokDanger
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
                    .stroke(status.color.opacity(0.5), lineWidth: 1.5)
                    .frame(width: 14, height: 14)
                    .scaleEffect(pulse ? 1.6 : 1.0)
                    .opacity(pulse ? 0 : 0.8)
            }
            Circle()
                .fill(status.color)
                .frame(width: 8, height: 8)
                .shadow(color: status.color.opacity(0.6), radius: pulse ? 4 : 2)
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
                                        colors: [c.primary.opacity(0.9), c.secondary.opacity(0.9)],
                                        startPoint: .topLeading, endPoint: .bottomTrailing
                                    )
                                )
                                : AnyShapeStyle(Color.primary.opacity(hovered ? 0.10 : 0.05))
                        )
                        .frame(width: 30, height: 30)
                    Image(systemName: section.icon)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundColor(isSelected ? .white : bg.primaryTextColor.opacity(0.7))
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
