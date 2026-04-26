// HubPanels.swift — placeholder detail panels for the hub skeleton.
//
// Each panel is intentionally a premium "coming soon" state rather than a
// blank rectangle — a big themed icon that pops in with a pixar spring, the
// section title, a one-line description of what will live here, and a tiny
// 3-bullet roadmap so the user knows what's coming. Data wiring lands in
// Phase 2 (Overview), Phase 3 (Projects), Phase 4 (Commands), Phase 5 (Settings).

import SwiftUI

// Overview lives in HubOverview.swift — it's the real data panel; the others
// are still premium "coming soon" placeholders until their phase ships.

// Projects panel lives in HubProjectDetail.swift — master-detail with a real
// drilldown, daily chart, model breakdown, and copy-CLI actions.

// Commands panel lives in HubCommands.swift.

// Settings panel lives in HubSettings.swift — reads/writes ~/.tokmeter/config.json.

// ─── Shared empty state ───────────────────────────────────────────────────

/// Premium placeholder: big themed icon that springs in with overshoot,
/// title, subtitle, and a "what's coming" list. Rendered inside every hub
/// panel until the real content lands.
struct HubComingSoonView: View {
    let icon: String
    let title: String
    let subtitle: String
    let bullets: [String]
    let theme: AppTheme

    @State private var appeared = false

    private var c: ThemeColors { theme.colors }
    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(spacing: 24) {
            Spacer(minLength: 0)

            // Hero icon — gradient-filled roundrect, springs in from 0.5×
            // with real overshoot. Pixar arrival: anticipation then pop.
            heroIcon
                .scaleEffect(appeared ? 1.0 : 0.5)
                .opacity(appeared ? 1.0 : 0.0)

            VStack(spacing: 8) {
                Text(title)
                    .font(.system(size: 26, weight: .bold, design: theme.fonts.heroDesign))
                    .foregroundColor(bg.primaryTextColor)

                Text(subtitle)
                    .font(.system(size: 13, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: 420)
            }
            .opacity(appeared ? 1.0 : 0.0)
            .offset(y: appeared ? 0 : 14)

            roadmap
                .opacity(appeared ? 1.0 : 0.0)
                .offset(y: appeared ? 0 : 18)

            // Soft tag line — signals this is placeholder, not broken.
            Text("Coming soon")
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                .tracking(2.5)
                .foregroundColor(c.accent)
                .padding(.horizontal, 14)
                .padding(.vertical, 5)
                .background(
                    Capsule().fill(c.accent.opacity(0.12))
                        .overlay(Capsule().stroke(c.accent.opacity(0.35), lineWidth: 1))
                )
                .scaleEffect(appeared ? 1.0 : 0.6)
                .opacity(appeared ? 1.0 : 0.0)

            Spacer(minLength: 0)
        }
        .padding(40)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            // Staggered pixar-spring entrance — big bounce on the icon,
            // text glides in just behind.
            withAnimation(.spring(response: 0.65, dampingFraction: 0.55).delay(0.06)) {
                appeared = true
            }
        }
    }

    // MARK: - Hero icon

    private var heroIcon: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 26)
                .fill(
                    LinearGradient(
                        colors: [c.primary, c.secondary, c.warm],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    )
                )
                .frame(width: 110, height: 110)
                .shadow(color: c.primary.opacity(0.35), radius: 18, y: 8)

            Image(systemName: icon)
                .font(.system(size: 48, weight: .bold))
                .foregroundStyle(.white)
        }
    }

    // MARK: - Roadmap bullets

    private var roadmap: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(bullets.enumerated()), id: \.offset) { _, bullet in
                HStack(alignment: .top, spacing: 10) {
                    Image(systemName: "sparkle")
                        .font(.system(size: 10, weight: .semibold))
                        .foregroundColor(c.accent)
                        .padding(.top, 3)
                    Text(bullet)
                        .font(.system(size: 12, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.primaryTextColor.opacity(0.85))
                    Spacer(minLength: 0)
                }
            }
        }
        .frame(maxWidth: 440, alignment: .leading)
        .padding(.horizontal, 20)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(Color.primary.opacity(bg.isLight ? 0.04 : 0.06))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .stroke(c.accent.opacity(0.18), lineWidth: 1)
                )
        )
    }
}
