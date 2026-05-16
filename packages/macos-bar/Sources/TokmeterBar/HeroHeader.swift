// HeroHeader.swift — the thematic hero strip at the top of the popover.
//
// Structure:
//   - One row: ♾️ (smaller) + TOKMETER wordmark + status (warming/stale/ECG)
//   - One row: $48.95 (hero number) · "today" inline at baseline
// Total hero height is ~110pt — down from the earlier 160pt — so the KPI
// cards and sections below get the vertical real estate.
//
// The hero BACKGROUND is entirely theme-driven. Each theme has its own
// variant (gradient / horizon / scanlines / paper / glass / etc) — the
// text composition stays the same regardless.

import SwiftUI

/// Top hero region of the popover. Renders a theme-specific backdrop plus
/// the TOKMETER identity + today's cost.
struct HeroHeader: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme
    /// Shared slow breathing flag driven by the parent — syncs the ♾️ scale
    /// with the hero glow and any shimmer placeholders.
    let breathToggle: Bool

    /// Briefly bumped to >1 / non-zero degrees when `todayCost` changes so
    /// the hero number reacts visibly to fresh data — secondary action that
    /// reinforces the ECG's "live" message.
    @State private var costWiggleScale: CGFloat = 1.0
    @State private var costWiggleAngle: Double = 0

    private var c: ThemeColors { theme.colors }

    var body: some View {
        // The hero content dictates the height — background paints behind via
        // .background(), so HeroBackground's unbounded fills (Color.black,
        // LinearGradient, etc) don't stretch the hero vertically. Previously
        // the background was a sibling ZStack layer and ate all available
        // space the VStack parent gave it.
        VStack(alignment: .leading, spacing: 0) {
            topRow
            valueRow
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 18)
        .padding(.top, 8)
        .padding(.bottom, 10)
        .background(
            HeroBackground(theme: theme, breathToggle: breathToggle)
                .clipShape(notchShape)
                .overlay(innerHighlight)
                .overlay(borderOverlay)
        )
        // Layered shadow — tight contact + soft ambient = real depth.
        .shadow(color: ambientShadow, radius: 18, x: 0, y: 10)
        .shadow(color: contactShadow, radius: 3,  x: 0, y: 1)
    }

    // MARK: - Rows

    /// Wordmark + status badge row. The ECG trace replaces a static pill
    /// when data is fresh and the daemon is alive.
    private var topRow: some View {
        HStack(alignment: .center, spacing: 8) {
            Text("♾️")
                .font(.system(size: 22))
                .scaleEffect(breathToggle ? 1.05 : 1.0)
                .animation(.easeInOut(duration: 4).repeatForever(autoreverses: true), value: breathToggle)
            Text("TOKMETER")
                .font(.system(size: 10, weight: .heavy, design: theme.fonts.labelDesign))
                .tracking(2.5)
                .foregroundColor(foreground.opacity(0.88))
            Spacer()
            statusIndicator
        }
    }

    /// Main value row. Hero number + "today" inline at the value baseline so
    /// we spend one row instead of two. Tight line-spacing keeps the whole
    /// hero from ballooning with leading whitespace around the glyphs.
    private var valueRow: some View {
        HStack(alignment: .lastTextBaseline, spacing: 6) {
            if loader.isWarming {
                skeletonHero
            } else {
                Text(Fmt.cost(loader.todayCost))
                    .font(theme.fonts.hero(size: heroFontSize))
                    .foregroundColor(foreground)
                    .contentTransition(.numericText())
                    .scaleEffect(costWiggleScale)
                    .rotationEffect(.degrees(costWiggleAngle))
                    // Tighten the text's intrinsic leading so large fonts don't
                    // leave vertical padding around glyphs. Caps the line height
                    // to the actual font size.
                    .fixedSize(horizontal: false, vertical: true)
                    .lineLimit(1)
                    .animation(.spring(response: 0.55, dampingFraction: 0.70), value: loader.todayCost)
                    .onChange(of: loader.todayCost) { _, _ in
                        // Two-step wiggle: pop up + tilt, then settle back.
                        // The seed-driven tilt direction adds organic variance.
                        let tiltDirection: Double = Bool.random() ? 1.0 : -1.0
                        costWiggleScale = 1.04
                        costWiggleAngle = 0.6 * tiltDirection
                        withAnimation(.spring(response: 0.32, dampingFraction: 0.50)) {
                            costWiggleScale = 1.0
                            costWiggleAngle = 0
                        }
                    }
                Text("today")
                    .font(.system(size: 10, weight: .medium, design: theme.fonts.bodyDesign))
                    .italic()
                    .foregroundColor(foreground.opacity(0.65))
            }
        }
    }

    // MARK: - Status indicator (pill or live ECG)

    @ViewBuilder
    private var statusIndicator: some View {
        switch theme {
        case .hud:       operationalPill
        case .terminal:  terminalCursor
        default:         EmptyView()
        }

        if loader.isWarming {
            warmingPill
        } else if loader.lastError != nil && loader.hasFreshData {
            stalePill
        } else if let live = loader.statbarSignals?.liveSession {
            // Something is actively running RIGHT NOW. Replace the generic
            // ECG with a concrete pointer — "claude-code · tokmeter · 4m" —
            // so the bar tells you what's live, not just that "data exists."
            liveSessionPill(live)
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
        } else if loader.isDaemonAlive {
            // No live session right now, but the daemon is alive — show the
            // scrolling ECG as a passive "data is fresh" heartbeat.
            EcgView(color: ecgColor)
                .frame(width: 78, height: 14)
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    /// Live-session pill — green dot + compact session descriptor. Reads as
    /// "something is happening right now and here's what." Tooltip shows the
    /// model + last-record cost for the user who wants the detail.
    private func liveSessionPill(_ live: LiveSession) -> some View {
        let dotColor = Color.tokSuccess
        let project = Fmt.projectBasename(live.project)
        return HStack(spacing: 5) {
            Circle()
                .fill(dotColor)
                .frame(width: 6, height: 6)
                .shadow(color: dotColor.opacity(0.7), radius: 3)
                .scaleEffect(breathToggle ? 1.0 : 0.75)
                .animation(
                    .easeInOut(duration: 1.2).repeatForever(autoreverses: true),
                    value: breathToggle
                )
            Text("\(project) · \(Fmt.liveAge(live.ageSeconds))")
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .tracking(0.3)
                .foregroundColor(foreground.opacity(0.92))
                .lineLimit(1)
        }
        .padding(.horizontal, 7)
        .padding(.vertical, 3)
        .background(Capsule().fill(dotColor.opacity(0.15)))
        .overlay(Capsule().strokeBorder(dotColor.opacity(0.35), lineWidth: 0.6))
        .help(
            "Live: \(live.provider) · \(Fmt.shortModel(live.model)) · "
            + "last call \(Fmt.cost(live.lastRecordCost))"
        )
    }

    private var ecgColor: Color {
        // Prefer a color that reads well against the hero BG per theme.
        switch theme {
        case .daylight: return c.highlight                  // warm amber on cream
        case .paper:    return c.highlight                  // editorial red on cream
        case .terminal: return c.secondary                  // phosphor green on black
        case .hud:      return c.secondary                  // phosphor green on tactical
        case .noise:    return Color.black.opacity(0.75)    // ink on canary yellow
        case .mint:     return c.highlight                  // brick-red on peach
        case .blueprint: return c.primary                   // technical blue on cream
        default:        return Color.white.opacity(0.85)    // clean white on dark heroes
        }
    }

    private var warmingPill: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(foreground)
                .frame(width: 6, height: 6)
                .opacity(breathToggle ? 1 : 0.5)
                .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: breathToggle)
            Text("WARMING")
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .tracking(1)
                .foregroundColor(foreground)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(foreground.opacity(0.18)))
    }

    private var stalePill: some View {
        Text("STALE")
            .font(.system(size: 9, weight: .heavy, design: .rounded))
            .tracking(1)
            .foregroundColor(.white)
            .padding(.horizontal, 8)
            .padding(.vertical, 3)
            .background(Capsule().fill(Color.orange.opacity(0.4)))
    }

    private var operationalPill: some View {
        HStack(spacing: 4) {
            Circle().fill(c.secondary).frame(width: 5, height: 5)
                .shadow(color: c.secondary, radius: 3)
            Text("OPERATIONAL")
                .font(.system(size: 8, weight: .heavy, design: .monospaced))
                .tracking(1.5).foregroundColor(c.secondary)
        }
        .padding(.horizontal, 8).padding(.vertical, 3)
        .overlay(RoundedRectangle(cornerRadius: 3).stroke(c.secondary.opacity(0.6), lineWidth: 0.8))
    }

    private var terminalCursor: some View {
        Text("READY_")
            .font(.system(size: 9, weight: .regular, design: .monospaced))
            .foregroundColor(c.secondary)
            .opacity(breathToggle ? 1.0 : 0.4)
            .animation(.easeInOut(duration: 0.7).repeatForever(autoreverses: true), value: breathToggle)
    }

    private var skeletonHero: some View {
        HStack(spacing: 8) {
            ShimmerBar(width: 120, height: 30, breathToggle: breathToggle)
            ShimmerBar(width: 42, height: 10, breathToggle: breathToggle)
        }
    }

    // MARK: - Theme-derived visual knobs

    /// Foreground text color tuned per hero. Light surfaces invert; tactical
    /// themes use their signature phosphor/ink hue.
    private var foreground: Color {
        switch theme {
        case .daylight, .paper, .noise, .mint, .blueprint:
            // Light surfaces — dark ink. The previous default-to-white was
            // baking white text into the canary-yellow Noise hero. .blueprint
            // is hidden from picker but kept here for consistency.
            return Color.black.opacity(0.92)
        case .hud, .terminal:   return c.secondary
        case .glass:            return Color.white.opacity(0.95)
        default:                return Color.white
        }
    }

    /// Synthwave and Paper go a hair larger for display effect.
    /// Most themes sit at 32pt — enough to dominate without inflating the hero.
    private var heroFontSize: CGFloat {
        switch theme {
        case .synthwave, .paper: return 34
        default:                 return 32
        }
    }

    private var ambientShadow: Color {
        switch theme {
        case .nebula:    return c.secondary.opacity(0.45)
        case .nocturne:  return c.accent.opacity(0.22)
        case .daylight:  return Color.black.opacity(0.12)
        case .synthwave: return c.primary.opacity(0.60)
        case .hud:       return c.secondary.opacity(0.30)
        case .terminal:  return c.secondary.opacity(0.40)
        case .paper:     return Color.black.opacity(0.08)
        case .glass:     return Color.black.opacity(0.18)
        case .aurora:    return c.accent.opacity(0.35)
        case .blueprint: return Color.black.opacity(0.10)
        case .noise:     return Color.black.opacity(0.40)   // hard offset reads as "stuck on"
        case .mint:      return Color.black.opacity(0.06)   // hairline whisper
        }
    }

    private var contactShadow: Color {
        theme.backgroundMode.isLight ? Color.black.opacity(0.08) : Color.black.opacity(0.30)
    }

    // MARK: - Shapes + overlays

    /// Bottom-rounded "notch" shape — the popover's top corners stay square
    /// to match the menubar chrome; bottom corners tuck inward.
    private var notchShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            cornerRadii: .init(topLeading: 0, bottomLeading: 26, bottomTrailing: 26, topTrailing: 0),
            style: .continuous
        )
    }

    /// Inner glossy highlight — a thin white gradient line along the top
    /// that sells "material." Flat-aesthetic themes opt out.
    @ViewBuilder
    private var innerHighlight: some View {
        switch theme {
        case .daylight, .hud, .terminal, .paper, .blueprint, .noise, .mint:
            EmptyView()
        default:
            notchShape.strokeBorder(
                LinearGradient(
                    colors: [Color.white.opacity(0.35), Color.white.opacity(0.0)],
                    startPoint: .top, endPoint: .center
                ),
                lineWidth: 1
            )
        }
    }

    private var borderOverlay: some View {
        let strokeColor: Color = {
            switch theme {
            case .daylight:  return Color.black.opacity(0.06)
            case .synthwave: return c.secondary.opacity(0.45)
            case .hud:       return c.secondary.opacity(0.30)
            case .terminal:  return c.secondary.opacity(0.40)
            case .paper:     return Color.black.opacity(0.18)
            case .glass:     return Color.white.opacity(0.25)
            case .noise:     return Color.black.opacity(0.45)   // ink frame
            case .mint:      return Color.black.opacity(0.12)   // hairline
            case .blueprint: return Color.black.opacity(0.18)
            default:         return Color.white.opacity(0.10)
            }
        }()
        return notchShape.stroke(strokeColor, lineWidth: 1)
    }
}
