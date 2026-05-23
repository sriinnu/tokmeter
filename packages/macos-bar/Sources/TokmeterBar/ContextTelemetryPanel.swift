// ContextTelemetryPanel.swift — cache hit/miss and context-drag cockpit.
//
// The ribbon is a glance. This panel is the "why does this feel expensive?"
// readout: cache hits, misses, fresh/write pressure, and estimated context drag
// in one compact menubar section.

import SwiftUI

struct ContextTelemetryPanel: View {
    let signals: StatbarSignals
    let theme: AppTheme

    private var bg: BackgroundMode { theme.backgroundMode }
    private var c: ThemeColors { theme.colors }

    private var cache: CacheHitToday { signals.cacheHitToday }
    private var hit: Double { cache.canonicalRate ?? cache.rate }
    private var miss: Double { cache.missRate ?? max(0, 1 - hit) }
    private var fresh: Double { cache.freshInputShare ?? miss + write }
    private var write: Double { cache.cacheWriteShare ?? 0 }
    private var totalInput: Int { cache.totalInputTokens ?? cache.cacheReadTokens + cache.inputTokens + (cache.cacheWriteTokens ?? 0) }

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack {
                // Three ORTHOGONAL buckets partition 100% of input → count is 3.
                SectionHeader(label: "CACHE & CONTEXT", count: totalInput > 0 ? 3 : 0, theme: theme)
            }

            // HIT + MISS + WRITE are mutually exclusive and sum to ~100% of
            // total input — no duplication. FRESH (= MISS + WRITE) is shown
            // as a derived roll-up line below, not as a 4th equal card.
            HStack(spacing: 8) {
                TelemetryMini(
                    label: "HIT",
                    value: "\(pct(hit))%",
                    tokens: cache.cacheReadTokens,
                    fill: hit,
                    color: cacheColor(hit),
                    icon: "tray.full.fill",
                    theme: theme
                )
                TelemetryMini(
                    label: "MISS",
                    value: "\(pct(miss))%",
                    tokens: cache.inputTokens,
                    fill: miss,
                    color: miss >= 0.35 ? Color.tokWarning : bg.secondaryTextColor,
                    icon: "tray",
                    theme: theme
                )
                TelemetryMini(
                    label: "WRITE",
                    value: "\(pct(write))%",
                    tokens: cache.cacheWriteTokens ?? 0,
                    fill: write,
                    color: c.accent,
                    icon: "square.and.arrow.down.fill",
                    theme: theme
                )
            }

            // Derived roll-up: fresh input is everything not served from cache
            // (MISS + WRITE). Thin labeled line, warning-tinted when it climbs.
            freshSummary

            if let pressure = signals.contextPressure, pressure.status != "none" {
                ContextDragRow(pressure: pressure, theme: theme)
            } else {
                HStack(spacing: 7) {
                    Image(systemName: "memorychip")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(bg.secondaryTextColor)
                    Text("Context drag estimate unavailable")
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(bg.secondaryTextColor)
                    Spacer()
                }
                .padding(.top, 2)
                .help("Providers do not expose a true context_drag field; Tokmeter estimates it once session input growth is visible.")
            }

            // No longer capped — the drawer is scrollable, so show every
            // project with context pressure today.
            let projects = signals.projectContextToday ?? []
            if !projects.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text("PROJECT PRESSURE")
                            .font(.system(size: 8, weight: .bold, design: theme.fonts.labelDesign))
                            .tracking(0.9)
                            .foregroundColor(bg.secondaryTextColor)
                        Spacer()
                        Text("hit / miss / drag")
                            .font(.system(size: 9, weight: .medium, design: theme.fonts.bodyDesign))
                            .foregroundColor(bg.secondaryTextColor)
                    }
                    ForEach(projects) { project in
                        ProjectContextRow(project: project, theme: theme)
                    }
                }
                .padding(.top, 2)
            }
        }
    }

    /// Derived "fresh input" roll-up. FRESH = MISS + WRITE — everything not
    /// served from cache. Shown as a thin labeled line (not a 4th equal card)
    /// so it stops duplicating MISS when WRITE is 0%. Warning tint past 45%.
    private var freshSummary: some View {
        let freshTokens = cache.freshInputTokens ?? cache.inputTokens + (cache.cacheWriteTokens ?? 0)
        let tint = fresh >= 0.45 ? Color.tokWarning : c.tertiary
        return HStack(spacing: 6) {
            Image(systemName: "plus.rectangle.fill")
                .font(.system(size: 9, weight: .semibold))
                .foregroundColor(tint)
            Text("FRESH INPUT")
                .font(.system(size: 8, weight: .bold, design: theme.fonts.labelDesign))
                .tracking(0.9)
                .foregroundColor(bg.secondaryTextColor)
            Text("\(pct(fresh))%")
                .font(.system(size: 10, weight: .bold, design: theme.fonts.valueDesign))
                .foregroundColor(tint)
                .contentTransition(.numericText())
            Text("·")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(bg.secondaryTextColor.opacity(0.6))
            Text(Fmt.number(freshTokens))
                .font(.system(size: 9, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
                .lineLimit(1)
            Spacer()
        }
        .padding(.vertical, 3)
        .help("Fresh input = miss + write — input not served from cache. Derived from the MISS and WRITE buckets above.")
    }

    static func hasContent(_ signals: StatbarSignals) -> Bool {
        let cache = signals.cacheHitToday
        if cache.cacheReadTokens + cache.inputTokens + (cache.cacheWriteTokens ?? 0) > 0 {
            return true
        }
        if let pressure = signals.contextPressure, pressure.status != "none" {
            return true
        }
        return false
    }

    private func pct(_ value: Double) -> Int {
        Int((max(0, min(1, value)) * 100).rounded())
    }

    private func cacheColor(_ rate: Double) -> Color {
        if rate >= 0.90 { return Color.tokSuccess }
        if rate >= 0.60 { return Color.tokWarning }
        return Color.tokDanger
    }
}

/// Slide-out "cache wallet" drawer. Renders a dimmed scrim plus a trailing
/// panel that carries the full ContextTelemetryPanel readout. Designed to be
/// dropped into an `.overlay` on the top-level popover VStack so it floats
/// above the scroll content. Closes via the back chevron, the close glyph, or
/// a tap on the scrim. The panel body scrolls so a long PROJECT PRESSURE list
/// stays reachable within the popover's fixed height.
struct CacheWalletDrawer: View {
    let signals: StatbarSignals
    let theme: AppTheme
    @Binding var isPresented: Bool

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        ZStack(alignment: .trailing) {
            // Dimmed scrim — tap anywhere off the panel to dismiss.
            Color.black.opacity(0.35)
                .ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { close() }
                .transition(.opacity)

            VStack(alignment: .leading, spacing: 0) {
                header
                Divider().opacity(0.25)
                ScrollView(.vertical, showsIndicators: true) {
                    ContextTelemetryPanel(signals: signals, theme: theme)
                        .padding(.horizontal, 14)
                        .padding(.top, 12)
                        .padding(.bottom, 16)
                }
            }
            .frame(width: 330)
            .frame(maxHeight: .infinity)
            .background(drawerBackground)
            .overlay(
                Rectangle()
                    .frame(width: 0.6)
                    .foregroundColor(bg.secondaryTextColor.opacity(0.18)),
                alignment: .leading
            )
            .shadow(color: Color.black.opacity(0.30), radius: 18, x: -6, y: 0)
            .transition(.move(edge: .trailing).combined(with: .opacity))
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button(action: close) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundColor(bg.primaryTextColor.opacity(0.85))
            }
            .buttonStyle(.plain)
            .help("Back")

            Image(systemName: "tray.full.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundColor(theme.colors.secondary)
            Text("CACHE & CONTEXT")
                .font(.system(size: 11, weight: .heavy, design: theme.fonts.labelDesign))
                .tracking(1.4)
                .foregroundColor(bg.primaryTextColor.opacity(0.9))
            Spacer()
            Button(action: close) {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(bg.secondaryTextColor)
            }
            .buttonStyle(.plain)
            .help("Close")
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
    }

    @ViewBuilder
    private var drawerBackground: some View {
        if bg.usesMaterial {
            ZStack {
                Rectangle().fill(.regularMaterial)
                LinearGradient(
                    colors: bg.gradientColors(),
                    startPoint: .top, endPoint: .bottom
                )
            }
        } else {
            LinearGradient(
                colors: bg.gradientColors(),
                startPoint: .top, endPoint: .bottom
            )
        }
    }

    private func close() {
        withAnimation(.spring(response: 0.45, dampingFraction: 0.82)) {
            isPresented = false
        }
    }
}

private struct ProjectContextRow: View {
    let project: ProjectContextToday
    let theme: AppTheme

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "folder.fill")
                .font(.system(size: 10, weight: .semibold))
                .foregroundColor(accent)
            Text(Fmt.projectBasename(project.project))
                .font(.system(size: 10, weight: .semibold, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.primaryTextColor)
                .lineLimit(1)
                .help(project.project)
            Spacer(minLength: 4)
            mini("H", project.cacheHitRate, color: cacheColor(project.cacheHitRate))
            mini("M", project.missRate, color: project.missRate >= 0.35 ? Color.tokWarning : bg.secondaryTextColor)
            mini("D", project.dragShare, color: accent)
        }
        .padding(.vertical, 3)
        .help(
            "\(project.project): \(Fmt.number(project.totalInputTokens)) input today, "
            + "\(Fmt.number(project.freshInputTokens)) fresh, "
            + "\(Fmt.number(project.dragTokens)) estimated drag tokens."
        )
    }

    private func mini(_ label: String, _ value: Double, color: Color) -> some View {
        HStack(spacing: 2) {
            Text(label)
                .font(.system(size: 8, weight: .bold, design: theme.fonts.labelDesign))
                .foregroundColor(bg.secondaryTextColor)
            Text("\(pct(value))%")
                .font(.system(size: 9, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(color)
                .contentTransition(.numericText())
        }
        .frame(width: 38, alignment: .trailing)
    }

    private func pct(_ value: Double) -> Int {
        Int((max(0, min(1, value)) * 100).rounded())
    }

    private func cacheColor(_ rate: Double) -> Color {
        if rate >= 0.90 { return Color.tokSuccess }
        if rate >= 0.60 { return Color.tokWarning }
        return Color.tokDanger
    }

    private var accent: Color {
        switch project.contextStatus {
        case "critical":
            return Color.tokDanger
        case "high":
            return Color.tokWarning
        case "medium":
            return theme.colors.tertiary
        default:
            return theme.backgroundMode.secondaryTextColor
        }
    }
}

private struct TelemetryMini: View {
    let label: String
    let value: String
    let tokens: Int
    let fill: Double
    let color: Color
    let icon: String
    let theme: AppTheme

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.system(size: 9, weight: .semibold))
                    .foregroundColor(color)
                Text(label)
                    .font(.system(size: 8, weight: .bold, design: theme.fonts.labelDesign))
                    .tracking(0.9)
                    .foregroundColor(bg.secondaryTextColor)
                Spacer(minLength: 0)
            }
            Text(value)
                .font(.system(size: 14, weight: .bold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor)
                .contentTransition(.numericText())
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(bg.secondaryTextColor.opacity(0.12))
                    Capsule()
                        .fill(color)
                        .frame(width: max(2, geo.size.width * max(0, min(1, fill))))
                        .animation(.spring(response: 0.45, dampingFraction: 0.78), value: fill)
                }
            }
            .frame(height: 4)
            Text(Fmt.number(tokens))
                .font(.system(size: 9, weight: .medium, design: theme.fonts.bodyDesign))
                .foregroundColor(bg.secondaryTextColor)
                .lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(8)
        .background(
            RoundedRectangle(cornerRadius: 7)
                .fill(bg.primaryTextColor.opacity(0.035))
        )
        .help("\(label.lowercased()) tokens: \(tokens)")
    }
}

private struct ContextDragRow: View {
    let pressure: ContextPressure
    let theme: AppTheme

    private var bg: BackgroundMode { theme.backgroundMode }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 7) {
                Image(systemName: "memorychip.fill")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(accent)
                Text("Drag")
                    .font(.system(size: 10, weight: .semibold, design: theme.fonts.labelDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text(pressure.status.uppercased())
                    .font(.system(size: 8, weight: .bold, design: theme.fonts.labelDesign))
                    .tracking(0.8)
                    .foregroundColor(accent)
                Spacer()
                Text("\(pct(pressure.dragShare))%")
                    .font(.system(size: 12, weight: .bold, design: theme.fonts.valueDesign))
                    .foregroundColor(bg.primaryTextColor)
                Text("· \(Fmt.number(pressure.dragTokens))")
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(bg.secondaryTextColor)
            }
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(bg.secondaryTextColor.opacity(0.12))
                    Capsule()
                        .fill(accent)
                        .frame(width: max(2, geo.size.width * max(0, min(1, pressure.dragShare))))
                }
            }
            .frame(height: 4)
            HStack(spacing: 10) {
                small("input", Fmt.number(pressure.currentInputTokens))
                small("base", Fmt.number(pressure.baselineInputTokens))
                small("turns", "\(pressure.turnCount)")
                Spacer()
            }
        }
        .padding(.top, 2)
        .help(pressure.reason)
    }

    private func small(_ label: String, _ value: String) -> some View {
        HStack(spacing: 3) {
            Text(label.uppercased())
                .font(.system(size: 8, weight: .semibold, design: theme.fonts.labelDesign))
                .tracking(0.6)
                .foregroundColor(bg.secondaryTextColor)
            Text(value)
                .font(.system(size: 9, weight: .semibold, design: theme.fonts.valueDesign))
                .foregroundColor(bg.primaryTextColor.opacity(0.9))
        }
    }

    private func pct(_ value: Double) -> Int {
        Int((max(0, min(1, value)) * 100).rounded())
    }

    private var accent: Color {
        switch pressure.status {
        case "critical":
            return Color.tokDanger
        case "high":
            return Color.tokWarning
        case "medium":
            return theme.colors.tertiary
        default:
            return theme.backgroundMode.secondaryTextColor
        }
    }
}
