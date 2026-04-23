// StatCards.swift — the three KPI cards (TOKENS / SPENT / STREAK) below the hero.
//
// Each card is a self-contained composition:
//   [icon badge]                 [delta pill]     ← top row
//              value                              ← center
//              label                              ← center
//   ~~sparkline~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~   ← bottom strip
//
// All cards draw through a theme-driven `cardBackground(...)` so Nebula gets
// glossy tint, Paper gets a hairline, HUD gets corner ticks, etc.
//
// Animations:
//   - Sparkline line draws in from 0→1 with spring on appear (Disney-feel).
//   - Value changes animate with `.contentTransition(.numericText())` plus
//     a spring easing curve so increments don't pop abruptly.
//   - Cards stagger in with a subtle scale + opacity on first render.

import SwiftUI

// MARK: - StatsGrid

/// Horizontal row of three KPI cards below the hero.
struct StatsGrid: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }

    var body: some View {
        HStack(spacing: 8) {
            StatCard(
                icon: "square.stack.3d.up.fill",
                label: "TOKENS",
                value: Fmt.number(loader.totalTokens),
                role: c.secondary,
                delta: weekDelta { Double($0.tokens) },
                sparkValues: loader.recentDaily.map { Double($0.tokens) },
                theme: theme,
                isWarming: loader.isWarming,
                index: 0
            )
            StatCard(
                icon: "dollarsign.circle.fill",
                label: "SPENT",
                value: Fmt.cost(loader.totalCost),
                role: c.highlight,
                delta: weekDelta { $0.cost },
                sparkValues: loader.recentDaily.map { $0.cost },
                theme: theme,
                isWarming: loader.isWarming,
                index: 1
            )
            if let s = loader.stats {
                StatCard(
                    icon: "flame.fill",
                    label: "STREAK",
                    value: "\(s.longestStreak)d",
                    role: c.tertiary,
                    delta: nil,
                    sparkValues: streakSpark(for: s),
                    theme: theme,
                    isWarming: false,
                    index: 2
                )
            }
        }
    }

    /// Percentage delta between today and yesterday. Returns nil when the
    /// week series is too short or yesterday is near-zero — the UI hides the
    /// pill in that case rather than showing a meaningless "∞%".
    private func weekDelta(extract: (DailyUsage) -> Double) -> Double? {
        guard loader.recentDaily.count >= 2 else { return nil }
        let sorted = loader.recentDaily
        let today = extract(sorted.last!)
        let yesterday = extract(sorted[sorted.count - 2])
        guard yesterday > 0.0001 else { return nil }
        return ((today - yesterday) / yesterday) * 100
    }

    /// A visually-balanced sparkline for the streak card — a gently rising
    /// line whose slope tracks activity density. Not raw data, but a signal.
    private func streakSpark(for s: StatsData) -> [Double] {
        let activeFraction = min(Double(s.activeDays) / 30.0, 1.0)
        return (0..<7).map { 0.3 + activeFraction * Double($0) / 6.0 }
    }
}

// MARK: - StatCard

/// One KPI card with icon badge, delta, value+label, and an animated
/// sparkline. Driven by theme for visual dressing.
struct StatCard: View {
    let icon: String
    let label: String
    let value: String
    let role: Color
    let delta: Double?
    let sparkValues: [Double]
    let theme: AppTheme
    let isWarming: Bool
    /// Card's position in the row (0..2). Controls enter-animation stagger.
    let index: Int

    /// Spring-animated line-draw progress from 0 → 1 on first appearance.
    @State private var sparkProgress: CGFloat = 0
    /// Opacity/scale enter state. Drops to 0/0.92 then springs into 1/1.
    @State private var appeared: Bool = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Top row: icon badge + delta pill
            HStack(alignment: .top, spacing: 0) {
                IconBadge(symbol: icon, role: role, cardMode: theme.cardMode)
                Spacer(minLength: 0)
                if let d = delta, !isWarming {
                    DeltaPill(percent: d)
                }
            }
            .padding(.horizontal, 10)
            .padding(.top, 9)

            Spacer(minLength: 0)

            VStack(spacing: 2) {
                if isWarming {
                    ShimmerBar(width: 52, height: 18, breathToggle: true)
                } else {
                    Text(value)
                        .font(theme.fonts.value(size: 22))
                        .foregroundColor(role)
                        .contentTransition(.numericText())
                        .animation(.spring(response: 0.55, dampingFraction: 0.70), value: value)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                }
                Text(label)
                    .font(theme.fonts.label(size: 9, weight: .semibold))
                    .tracking(0.5)
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 6)

            Spacer(minLength: 0)

            // Sparkline — scroll into view with spring-eased draw-in.
            InlineSparkline(values: sparkValues, color: role, progress: sparkProgress)
                .frame(height: 18)
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
        }
        .frame(height: 108)
        .background(CardBackground(role: role, cardMode: theme.cardMode, themeColors: theme.colors))
        .scaleEffect(appeared ? 1.0 : 0.92)
        .opacity(appeared ? 1.0 : 0.0)
        .onAppear {
            // Staggered entry so the cards cascade in — left then center then right.
            let delay = Double(index) * 0.06
            withAnimation(.spring(response: 0.55, dampingFraction: 0.75).delay(delay)) {
                appeared = true
            }
            withAnimation(.spring(response: 1.1, dampingFraction: 0.85).delay(delay + 0.05)) {
                sparkProgress = 1.0
            }
        }
    }
}

// MARK: - Icon badge

/// Small rounded square with a role-colored SF Symbol. Corner radius shifts
/// for HUD/Terminal/Paper to match each theme's overall geometry.
struct IconBadge: View {
    let symbol: String
    let role: Color
    let cardMode: CardMode

    private var radius: CGFloat {
        switch cardMode {
        case .hudPanel, .terminalPanel: return 3
        case .paperHairline: return 2
        default: return 6
        }
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: radius)
                .fill(role.opacity(0.22))
                .overlay(
                    RoundedRectangle(cornerRadius: radius)
                        .strokeBorder(role.opacity(0.35), lineWidth: 0.6)
                )
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(role)
        }
        .frame(width: 22, height: 22)
    }
}

// MARK: - Delta pill

/// Small up/down-percentage pill. Green for positive, red for negative.
/// System semantic colors aren't used because we want consistent hue across
/// light and dark surfaces.
struct DeltaPill: View {
    let percent: Double

    var body: some View {
        let positive = percent >= 0
        let color: Color = positive
            ? Color(red: 0.13, green: 0.80, blue: 0.47)
            : Color(red: 0.96, green: 0.42, blue: 0.42)
        HStack(spacing: 2) {
            Image(systemName: positive ? "arrow.up" : "arrow.down")
                .font(.system(size: 7, weight: .bold))
            Text(String(format: "%.1f%%", abs(percent)))
                .font(.system(size: 9, weight: .semibold, design: .rounded))
        }
        .foregroundColor(color)
        .padding(.horizontal, 5)
        .padding(.vertical, 2)
        .background(Capsule().fill(color.opacity(0.18)))
    }
}

// MARK: - Inline sparkline

/// Tiny line+area chart that sits at the bottom of a KPI card. The line
/// animates in from 0→1 on appear via the `progress` parameter (owned by
/// the parent so it can time the stagger).
struct InlineSparkline: View {
    let values: [Double]
    let color: Color
    /// 0 → 1 draw-in progress. Parent animates this with a spring.
    let progress: CGFloat

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height
            let minV = values.min() ?? 0
            let maxV = values.max() ?? 0
            let range = max(maxV - minV, 0.0001)
            let step = values.count > 1 ? w / CGFloat(values.count - 1) : 0
            let point: (Int, Double) -> CGPoint = { i, v in
                CGPoint(
                    x: CGFloat(i) * step,
                    y: h - (CGFloat((v - minV) / range) * (h - 2)) - 1
                )
            }

            if values.count < 2 {
                EmptyView()
            } else {
                ZStack {
                    // Area under line — fades from colored at top to clear at bottom.
                    Path { p in
                        p.move(to: CGPoint(x: 0, y: h))
                        for (i, v) in values.enumerated() {
                            p.addLine(to: point(i, v))
                        }
                        p.addLine(to: CGPoint(x: w, y: h))
                        p.closeSubpath()
                    }
                    .fill(LinearGradient(
                        colors: [color.opacity(0.25), color.opacity(0.0)],
                        startPoint: .top, endPoint: .bottom
                    ))
                    .mask(
                        // Animate the mask from left to right so the area appears along with the line.
                        Rectangle().frame(width: w * progress)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    )
                    // Line itself — trim-animated by progress.
                    Path { p in
                        for (i, v) in values.enumerated() {
                            let pt = point(i, v)
                            if i == 0 { p.move(to: pt) } else { p.addLine(to: pt) }
                        }
                    }
                    .trim(from: 0, to: progress)
                    .stroke(color.opacity(0.85),
                            style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                }
            }
        }
    }
}

// The card chrome (fill + border + shadow per theme) and corner ticks live
// in CardBackground.swift to keep this file focused on layout.
