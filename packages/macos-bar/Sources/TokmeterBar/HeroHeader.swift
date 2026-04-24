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

    private var c: ThemeColors { theme.colors }

    var body: some View {
        ZStack(alignment: .topLeading) {
            HeroBackground(theme: theme, breathToggle: breathToggle)
                .clipShape(notchShape)
                .overlay(innerHighlight)
                .overlay(borderOverlay)
                // Layered shadow — tight contact + soft ambient = real depth.
                .shadow(color: ambientShadow, radius: 18, x: 0, y: 10)
                .shadow(color: contactShadow, radius: 3,  x: 0, y: 1)

            VStack(alignment: .leading, spacing: 2) {
                topRow
                valueRow
            }
            .padding(.horizontal, 18)
            .padding(.top, 12)
            .padding(.bottom, 14)
        }
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
    /// we spend one row instead of two. Feels confident, not busy.
    private var valueRow: some View {
        HStack(alignment: .lastTextBaseline, spacing: 6) {
            if loader.isWarming {
                skeletonHero
            } else {
                Text(Fmt.cost(loader.todayCost))
                    .font(theme.fonts.hero(size: heroFontSize))
                    .foregroundColor(foreground)
                    .contentTransition(.numericText())
                    .animation(.spring(response: 0.55, dampingFraction: 0.70), value: loader.todayCost)
                Text("today")
                    .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
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
        } else if loader.isDaemonAlive {
            // Live heartbeat — a scrolling ECG trace only when we're confident
            // the data is current. Disappears when warming or stale, so the
            // badge always tells the user which state they're in.
            EcgView(color: ecgColor)
                .frame(width: 78, height: 14)
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
        }
    }

    private var ecgColor: Color {
        // Prefer a color that reads well against the hero BG per theme.
        switch theme {
        case .daylight: return c.highlight                  // warm amber on cream
        case .paper:    return c.highlight                  // editorial red on cream
        case .terminal: return c.secondary                  // phosphor green on black
        case .hud:      return c.secondary                  // phosphor green on tactical
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
        case .daylight, .paper: return Color.black.opacity(0.92)
        case .hud, .terminal:   return c.secondary
        case .glass:            return Color.white.opacity(0.95)
        default:                return Color.white
        }
    }

    /// Synthwave and Paper go a hair larger for display effect.
    private var heroFontSize: CGFloat {
        switch theme {
        case .synthwave, .paper: return 40
        default:                 return 38
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
        case .daylight, .hud, .terminal, .paper:
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
            default:         return Color.white.opacity(0.10)
            }
        }()
        return notchShape.stroke(strokeColor, lineWidth: 1)
    }
}
