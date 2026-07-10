// DataSections.swift — the three scrolling sections under the stats grid:
//
//   • TOP MODELS — bar per model, width by cost share
//   • LAST 7 DAYS — Swift Charts line + area
//   • SESSIONS — project rows with cost, with "show all" expansion
//
// Each section is its own small View struct so the parent body stays flat.
// Data changes animate with spring easings so refreshes feel live, not
// abrupt — matching the ECG heartbeat in the hero.

import Charts
import SwiftUI

// MARK: - Models section

/// Per-model cost bars. Each row is [icon + name] [bar] [cost].
/// A small "All time / Today" pill toggle switches between the two views.
struct ModelsSection: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    @State private var showToday: Bool = false

    private var c: ThemeColors { theme.colors }
    private var activeModels: [ModelUsage] { showToday ? loader.todayModels : loader.topModels }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center) {
                SectionHeader(
                    label: showToday ? "TODAY'S MODELS" : "TOP MODELS",
                    count: activeModels.count,
                    theme: theme
                )
                Spacer()
                modelTabPill
            }

            if loader.isWarming {
                ForEach(0..<3, id: \.self) { _ in
                    ShimmerBar(width: 280, height: 14, breathToggle: true)
                }
            } else if activeModels.isEmpty {
                Text(showToday ? "No model activity yet today." : "No model data.")
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
            } else {
                let maxCost = activeModels.first?.cost ?? 1
                ForEach(activeModels) { model in
                    modelRow(model, maxCost: maxCost)
                }
            }
        }
    }

    private var modelTabPill: some View {
        HStack(spacing: 0) {
            tabButton(label: "All", active: !showToday) { showToday = false }
            tabButton(label: "Today", active: showToday)  { showToday = true }
        }
        .background(
            Capsule().fill(Color.primary.opacity(0.06))
        )
    }

    private func tabButton(label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { withAnimation(.spring(response: 0.25, dampingFraction: 0.80)) { action() } }) {
            Text(label)
                .font(.system(size: 9, weight: active ? .semibold : .regular, design: theme.fonts.bodyDesign))
                .foregroundColor(active ? theme.backgroundMode.primaryTextColor : theme.backgroundMode.secondaryTextColor)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(active ? Capsule().fill(c.accent.opacity(0.18)) : nil)
        }
        .buttonStyle(.borderless)
    }

    /// True whenever cost is honestly $0 rather than guessed — covers both
    /// quota-billed/activity-only clients (VS Code Copilot, Antigravity —
    /// zero tokens AND zero cost, nothing local to measure) and a real-but-
    /// unpriced total (Codex Desktop's SQLite fallback — a genuine non-zero
    /// token count with cost intentionally left unexposed rather than
    /// guessing an input/output split to price it from). Drawn distinctly so
    /// neither case reads as "$0.00 = confirmed free."
    private func isActivityOnly(_ model: ModelUsage) -> Bool {
        model.cost == 0
    }

    private func modelRow(_ model: ModelUsage, maxCost: Double) -> some View {
        let activityOnly = isActivityOnly(model)
        return HStack(spacing: 8) {
            HStack(spacing: 3) {
                Image(systemName: providerGlyph(for: model.model))
                    .font(.system(size: 10))
                    .foregroundColor(c.accent)
                Text(Fmt.shortModel(model.model))
                    .font(.system(size: 11, weight: .medium, design: .monospaced))
                    .foregroundColor(theme.backgroundMode.primaryTextColor)
                    .lineLimit(1)
            }
            .frame(width: 110, alignment: .leading)
            GeometryReader { geo in
                let pct = CGFloat(min(model.cost / max(maxCost, 0.01), 1.0))
                Capsule()
                    .fill(Color.gray.opacity(0.15))
                    .overlay(
                        HStack {
                            Capsule()
                                .fill(
                                    activityOnly
                                        ? AnyShapeStyle(Color.gray.opacity(0.35))
                                        : AnyShapeStyle(compositionFill(
                                            output: model.outputTokens,
                                            cacheRead: model.cacheReadTokens,
                                            cacheWrite: model.cacheWriteTokens,
                                            input: model.inputTokens,
                                            reasoning: model.reasoningTokens,
                                            theme: theme,
                                            fallback: LinearGradient(
                                                colors: [c.secondary, c.warm],
                                                startPoint: .leading, endPoint: .trailing
                                            )
                                        ))
                                )
                                .frame(width: safeDim(geo.size.width * (activityOnly ? 0.12 : pct), floor: 4))
                            Spacer(minLength: 0)
                        }
                    )
                    .frame(height: 6)
                    .animation(.spring(response: 0.6, dampingFraction: 0.75), value: model.cost)
            }
            .frame(height: 6)
            .help(
                activityOnly
                    ? (model.tokens > 0
                        ? "Real token count from this provider's local state — cost isn't shown because there's no reliable input/output split to price it from."
                        : "This provider doesn't expose token counts or cost locally — only that you used it.")
                    : compositionTooltip(
                        output: model.outputTokens,
                        cacheRead: model.cacheReadTokens,
                        cacheWrite: model.cacheWriteTokens,
                        input: model.inputTokens,
                        reasoning: model.reasoningTokens
                    )
            )
            if activityOnly {
                // A known-zero-cost row can still carry a real, honest token
                // count (e.g. Codex Desktop's SQLite-sourced total) — show
                // that number rather than an unhelpful "no cost data" when we
                // actually have real data, just not a priceable one.
                Text(model.tokens > 0 ? "\(Fmt.number(model.tokens)) tok" : "no cost data")
                    .font(.system(size: 9, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
                    .frame(width: 56, alignment: .trailing)
            } else {
                Text(Fmt.cost(model.cost))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(costTint(for: model))
                    .frame(width: 56, alignment: .trailing)
            }
        }
    }

    // MARK: - Cost tint (extension A)

    /// Tint the $cost with the dominant tier color when the bar went solid.
    /// Tied to the bar's own threshold via the shared helper so a mixed-color
    /// bar always pairs with a neutral $.
    private func costTint(for model: ModelUsage) -> Color {
        dominantTierColor(
            output: model.outputTokens,
            cacheRead: model.cacheReadTokens,
            cacheWrite: model.cacheWriteTokens,
            input: model.inputTokens,
            reasoning: model.reasoningTokens,
            theme: theme
        ) ?? c.highlight
    }

    // MARK: - Provider glyph (extension C)

    /// Map model name to a provider glyph. Letter-disc glyphs (a.circle.fill /
    /// g.circle.fill / m.circle.fill) win over dotted-grid glyphs at 10pt —
    /// OpenAI's hexagongrid and Google's 3x3 grid were both reading as "dotted
    /// disc" below the perceptual floor. Letter discs are unambiguous.
    ///
    /// Namespace handling: strip a leading `openrouter/` (and any single-
    /// segment `provider/` prefix from kilo/opencode/roo) before matching, so
    /// `openrouter/anthropic/claude-opus-4-7` still gets the sparkle.
    private func providerGlyph(for model: String) -> String {
        let raw = model.lowercased()
        // Strip a leading openrouter/ then check the rest.
        let n: String
        if raw.hasPrefix("openrouter/") {
            n = String(raw.dropFirst("openrouter/".count))
        } else {
            n = raw
        }
        if n.hasPrefix("claude") || n.hasPrefix("anthropic/")
            || n.contains("/claude")                            { return "sparkle" }
        if n.hasPrefix("gpt") || n.hasPrefix("openai/")
            || n.hasPrefix("o1") || n.hasPrefix("o3")
            || n.hasPrefix("codex")
            || n.contains("/gpt")                               { return "circle.hexagongrid.fill" }
        if n.hasPrefix("gemini") || n.hasPrefix("google/")
            || n.contains("/gemini")                            { return "g.circle.fill" }
        if n.hasPrefix("qwen") || n.hasPrefix("alibaba/")      { return "diamond.fill" }
        if n.hasPrefix("deepseek")                              { return "triangle.fill" }
        if n.hasPrefix("mistral")                               { return "m.circle.fill" }
        if n.hasPrefix("llama") || n.hasPrefix("meta/")        { return "leaf.fill" }
        if n.hasPrefix("kimi") || n.hasPrefix("moonshot")      { return "moon.fill" }
        if n.hasPrefix("minimax")                               { return "infinity" }
        if n.hasPrefix("grok") || n.hasPrefix("xai/")          { return "x.circle.fill" }
        return "waveform.circle"
    }

}

// MARK: - Week section

/// Last-7-days line chart. Data changes animate with a spring curve so new
/// values glide into place instead of snapping.
struct WeekSection: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    /// 0→1 over ~0.9s on first appear. Drives a leading-edge mask so the
    /// chart reveals left-to-right like an ink pen drawing the line.
    @State private var drawProgress: CGFloat = 0

    private var c: ThemeColors { theme.colors }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(label: "LAST 7 DAYS", count: loader.recentDaily.count, theme: theme)

            if loader.isWarming {
                ShimmerBar(width: 340, height: 60, breathToggle: true)
            } else {
                Chart(loader.recentDaily) { day in
                    LineMark(
                        x: .value("Date", String(day.date.suffix(5))),
                        y: .value("Cost", day.cost)
                    )
                    .foregroundStyle(LinearGradient(
                        colors: [c.accent, c.warm],
                        startPoint: .leading, endPoint: .trailing))
                    .interpolationMethod(.catmullRom)
                    .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))

                    AreaMark(
                        x: .value("Date", String(day.date.suffix(5))),
                        y: .value("Cost", day.cost)
                    )
                    .foregroundStyle(LinearGradient(
                        colors: [c.accent.opacity(0.3), .clear],
                        startPoint: .top, endPoint: .bottom))
                    .interpolationMethod(.catmullRom)
                }
                .frame(height: 60)
                .chartYAxis(.hidden)
                .chartXAxis {
                    AxisMarks { value in
                        AxisValueLabel {
                            Text(value.as(String.self) ?? "")
                                .font(.system(size: 9, design: .rounded))
                                .foregroundColor(theme.backgroundMode.secondaryTextColor)
                        }
                    }
                }
                // Leading-edge mask animates from 0 to full width on first render.
                // Wrapped here so the chart's own animation modifier still handles
                // data updates after the initial draw-in.
                .mask(
                    GeometryReader { geo in
                        Rectangle()
                            .frame(width: safeDim(geo.size.width * drawProgress))
                    }
                )
                .animation(.spring(response: 0.7, dampingFraction: 0.80), value: loader.recentDaily.map(\.cost))
                .onAppear {
                    withAnimation(.easeOut(duration: 0.9)) { drawProgress = 1.0 }
                }
            }
        }
    }
}

// MARK: - Sessions section

/// Per-project rows — basename + day count + cost — with a "Show all N" fold.
struct SessionsSection: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme
    @Binding var showAll: Bool

    private var c: ThemeColors { theme.colors }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            SectionHeader(label: "SESSIONS", count: loader.sessions.count, theme: theme)

            if loader.isWarming {
                ForEach(0..<5, id: \.self) { _ in
                    ShimmerBar(width: 340, height: 28, breathToggle: true)
                }
            } else {
                let visible = showAll ? loader.sessions : Array(loader.sessions.prefix(8))
                ForEach(visible) { session in
                    row(session)
                }
                if loader.sessions.count > 8 && !showAll {
                    Button {
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) { showAll = true }
                    } label: {
                        HStack(spacing: 4) {
                            Text("Show all \(loader.sessions.count)")
                                .font(.system(size: 11, weight: .medium, design: theme.fonts.bodyDesign))
                            Image(systemName: "chevron.down").font(.system(size: 9))
                        }
                        .foregroundColor(c.accent)
                    }
                    .buttonStyle(.borderless)
                    .padding(.top, 4)
                }
            }
        }
    }

    private func row(_ session: ProjectData) -> some View {
        SessionRow(session: session, theme: theme, rowBackground: AnyView(rowBackground))
    }

    /// A single project row. Has its own @State for hover so only THIS row
    /// re-renders when hovered, not the whole session list.
    private struct SessionRow: View {
        let session: ProjectData
        let theme: AppTheme
        let rowBackground: AnyView

        @State private var hovered = false

        private var c: ThemeColors { theme.colors }

        var body: some View {
            HStack(spacing: 10) {
                Circle().fill(c.secondary).frame(width: 6, height: 6)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Fmt.projectBasename(session.project))
                        .font(.system(size: 12, weight: .medium, design: theme.fonts.bodyDesign))
                        .foregroundColor(theme.backgroundMode.primaryTextColor)
                        .lineLimit(1)
                        .help(session.project)
                    Text("\(session.activeDays)d  ·  \(Fmt.number(session.totalTokens)) tokens")
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(theme.backgroundMode.secondaryTextColor)
                }
                Spacer()
                Text(Fmt.cost(session.totalCost))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(c.highlight)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                // Hover flourish: a 1.5pt accent bar fades in on the leading
                // edge. Layered under the theme-aware rowBackground so the
                // chrome stays consistent across themes.
                rowBackground
                    .overlay(alignment: .leading) {
                        if hovered {
                            Rectangle()
                                .fill(c.accent)
                                .frame(width: 1.5)
                                .transition(.opacity)
                        }
                    }
            )
            .offset(y: hovered ? -1 : 0)
            .animation(.spring(response: 0.32, dampingFraction: 0.80), value: hovered)
            .onHover { hovered = $0 }
        }
    }

    /// Row background adapted per theme's card language — papery on Paper,
    /// black+green-border on Terminal, material on Glass, etc.
    @ViewBuilder
    private var rowBackground: some View {
        let radius: CGFloat = 8
        switch theme.cardMode {
        case .lightPaper:
            RoundedRectangle(cornerRadius: radius)
                .fill(Color.white)
                .shadow(color: Color.black.opacity(0.04), radius: 3, x: 0, y: 1)
        case .paperHairline:
            Rectangle().fill(Color.clear)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Color.black.opacity(0.12)).frame(height: 0.5)
                }
        case .terminalPanel:
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.black)
                .overlay(RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(c.secondary.opacity(0.30), lineWidth: 0.6))
        case .hudPanel:
            RoundedRectangle(cornerRadius: 4)
                .fill(Color.gray.opacity(0.08))
                .overlay(RoundedRectangle(cornerRadius: 4)
                    .strokeBorder(c.secondary.opacity(0.22), lineWidth: 0.5))
        case .neonOutlined:
            RoundedRectangle(cornerRadius: radius)
                .fill(Color.black.opacity(0.30))
                .overlay(RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(c.primary.opacity(0.35), lineWidth: 0.8))
        case .glassFrost:
            RoundedRectangle(cornerRadius: radius)
                .fill(.ultraThinMaterial)
                .overlay(RoundedRectangle(cornerRadius: radius)
                    .strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
        default:
            RoundedRectangle(cornerRadius: radius).fill(Color.gray.opacity(0.10))
        }
    }
}
