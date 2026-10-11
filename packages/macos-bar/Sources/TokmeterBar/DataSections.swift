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
    /// Opens the Rates panel ($ per million per model, and the price source).
    var showRates: Binding<Bool>? = nil

    @State private var showToday: Bool = true
    @State private var showAllModels: Bool = false

    private var c: ThemeColors { theme.colors }
    /// Claude Code logs `<synthetic>` placeholder turns with no tokens and no
    /// cost; they're not a model anyone chose, so they're left out of the list.
    private var availableModels: [ModelUsage] {
        (showToday ? loader.todayModels : loader.topModels)
            .filter { !Fmt.isEmptySynthetic(model: $0.model, tokens: $0.tokens, cost: $0.cost) }
    }
    private var activeModels: [ModelUsage] {
        if showAllModels { return availableModels }
        let ranked = Array(availableModels.prefix(5))
        guard showToday else { return ranked }
        // Preserve visibility for activity whose cost isn't exposed.
        let rankedIDs = Set(ranked.map(\.id))
        return ranked + availableModels.filter { $0.cost == 0 && !rankedIDs.contains($0.id) }.prefix(3)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if theme == .paper { InkRule().padding(.bottom, -2) }
            HStack(alignment: .center) {
                SectionHeader(
                    label: showToday ? "TODAY'S MODELS" : "TOP MODELS",
                    count: availableModels.count,
                    theme: theme,
                    ruled: false
                )
                Spacer()
                if let showRates {
                    RatesButton(isPresented: showRates, theme: theme)
                }
                modelTabPill
            }

            if loader.daemonPhase == .warming {
                ForEach(0..<3, id: \.self) { _ in
                    ShimmerBar(width: 280, height: 14, breathToggle: true)
                }
            } else if activeModels.isEmpty {
                Text(showToday ? "No model activity yet today." : "No model data.")
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
            } else {
                let maxCost = activeModels.first?.cost ?? 1
                // The same model can appear under two providers (codex +
                // codex-desktop) — those rows are otherwise byte-identical
                // (glyph and label derive from the model name), so surface
                // the provider on exactly the ambiguous ones.
                let dupNames = Set(
                    Dictionary(grouping: activeModels, by: \.model)
                        .filter { $0.value.count > 1 }.keys
                )
                ForEach(activeModels) { model in
                    modelRow(model, maxCost: maxCost, showProvider: dupNames.contains(model.model))
                }
                if showAllModels || availableModels.count > activeModels.count {
                    Button(showAllModels ? "Show fewer" : "Show all \(availableModels.count) models") {
                        showAllModels.toggle()
                    }
                    .buttonStyle(.plain)
                    .font(.system(size: 10, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
                }
            }
        }
    }

    @ViewBuilder
    private var modelTabPill: some View {
        if let custom = theme.skin?.spec.modelTabs(showToday: $showToday, theme: theme) {
            custom
        } else {
            standardTabPill
        }
    }

    private var standardTabPill: some View {
        HStack(spacing: 0) {
            tabButton(label: "All", active: !showToday) { showToday = false }
            tabButton(label: "Today", active: showToday)  { showToday = true }
        }
        .background(theme == .paper ? nil : Capsule().fill(Color.primary.opacity(0.06)))
    }

    private func tabButton(label: String, active: Bool, action: @escaping () -> Void) -> some View {
        Button(action: { withAnimation(.spring(response: 0.25, dampingFraction: 0.80)) { action() } }) {
            Text(label)
                .font(.system(size: 9, weight: active ? .semibold : .regular, design: theme.fonts.bodyDesign))
                .foregroundColor(active ? theme.backgroundMode.primaryTextColor : theme.backgroundMode.secondaryTextColor)
                .padding(.horizontal, 7)
                .padding(.vertical, 3)
                .background(active && theme != .paper ? Capsule().fill(c.accent.opacity(0.18)) : nil)
                .overlay(alignment: .bottom) {
                    if active && theme == .paper { InkRule(weight: 1.5).padding(.horizontal, 7) }
                }
        }
        .buttonStyle(.plain)
    }

    /// True whenever cost is honestly $0 rather than guessed — covers both
    /// quota-billed/activity-only clients (VS Code Copilot, Antigravity —
    /// zero tokens AND zero cost, nothing local to measure) and a real-but-
    /// unpriced total (Codex Desktop's SQLite fallback — a genuine non-zero
    /// token count with cost intentionally left unexposed rather than
    /// guessing an input/output split to price it from). Drawn distinctly so
    /// neither case reads as "$0.00 = confirmed free."
    private func isActivityOnly(_ model: ModelUsage) -> Bool {
        guard model.cost == 0 else { return false }
        if showToday, let basis = loader.statbarSignals?.modelCostBasisToday?[model.id] {
            return basis.unavailableRecords > 0 || basis.estimatedRecords + basis.reportedRecords == 0
        }
        return true
    }

    @ViewBuilder
    private func modelRow(_ model: ModelUsage, maxCost: Double, showProvider: Bool = false) -> some View {
        if let skin = theme.skin {
            let activityOnly = isActivityOnly(model)
            SkinModelRow(skin: skin, row: ModelRowData(
                model: model,
                name: Fmt.shortModel(model.model),
                provider: showProvider ? model.provider : nil,
                share: activityOnly ? 0 : min(model.cost / max(maxCost, 0.01), 1.0),
                activityOnly: activityOnly,
                help: modelHelp(model, activityOnly: activityOnly)
            ), theme: theme)
        } else if theme == .paper {
            paperModelRow(model, maxCost: maxCost, showProvider: showProvider)
        } else {
            standardModelRow(model, maxCost: maxCost, showProvider: showProvider)
        }
    }

    /// Paper: a newspaper column chart. Serif name, a thin ink bar on a
    /// hairline track, the figure in ink. The token mix stays in the tooltip.
    private func paperModelRow(_ model: ModelUsage, maxCost: Double, showProvider: Bool) -> some View {
        let activityOnly = isActivityOnly(model)
        return HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 0) {
                Text(Fmt.shortModel(model.model))
                    .font(Broadsheet.display(12.5, weight: .semibold))
                    .foregroundColor(Broadsheet.ink)
                    .lineLimit(1)
                    .truncationMode(.middle)
                if showProvider {
                    Text(model.provider)
                        .font(.system(size: 9, design: .serif).italic())
                        .foregroundColor(Broadsheet.muted)
                        .lineLimit(1)
                }
            }
            .frame(width: 118, alignment: .leading)
            GeometryReader { geo in
                let pct = CGFloat(min(model.cost / max(maxCost, 0.01), 1.0))
                ZStack(alignment: .leading) {
                    Rectangle().fill(Broadsheet.ink.opacity(0.18)).frame(height: 0.5)
                    Rectangle()
                        .fill(activityOnly ? Broadsheet.muted.opacity(0.5) : Broadsheet.ink)
                        .frame(width: safeDim(geo.size.width * (activityOnly ? 0.12 : pct), floor: 3), height: 4)
                }
                .frame(maxHeight: .infinity)
                .animation(.spring(response: 0.6, dampingFraction: 0.75), value: model.cost)
            }
            .frame(height: 8)
            .help(modelHelp(model, activityOnly: activityOnly))
            Text(activityOnly ? "n/a" : Fmt.money(model.cost))
                .font(activityOnly
                      ? .system(size: 10, design: .serif).italic()
                      : Broadsheet.display(12.5, weight: .bold).monospacedDigit())
                .foregroundColor(activityOnly ? Broadsheet.muted : Broadsheet.ink)
                .frame(width: 56, alignment: .trailing)
        }
        .padding(.vertical, 1)
    }

    private func modelHelp(_ model: ModelUsage, activityOnly: Bool) -> String {
        activityOnly
            ? (model.tokens > 0
                ? "\(Fmt.number(model.tokens)) tokens. Cost is unavailable because pricing or a reliable token breakdown is missing."
                : "This provider doesn't expose token counts or cost locally — only that you used it.")
            : "\(model.tokens.formatted()) tokens · \(Fmt.money(model.cost)) cost\n" + compositionTooltip(
                output: model.outputTokens,
                cacheRead: model.cacheReadTokens,
                cacheWrite: model.cacheWriteTokens,
                input: model.inputTokens,
                reasoning: model.reasoningTokens
            )
    }

    private func standardModelRow(_ model: ModelUsage, maxCost: Double, showProvider: Bool) -> some View {
        let activityOnly = isActivityOnly(model)
        return HStack(spacing: 8) {
            HStack(spacing: 3) {
                Image(systemName: providerGlyph(for: model.model))
                    .font(.system(size: 10))
                    .foregroundColor(c.accent)
                VStack(alignment: .leading, spacing: 0) {
                    Text(Fmt.shortModel(model.model))
                        .font(.system(size: 11, weight: .medium, design: .monospaced))
                        .foregroundColor(theme.backgroundMode.primaryTextColor)
                        .lineLimit(1)
                    if showProvider {
                        Text(model.provider)
                            .font(.system(size: 8, design: theme.fonts.bodyDesign))
                            .foregroundColor(theme.backgroundMode.secondaryTextColor)
                            .lineLimit(1)
                    }
                }
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
                        ? "\(Fmt.number(model.tokens)) tokens. Cost is unavailable because pricing or a reliable token breakdown is missing."
                        : "This provider doesn't expose token counts or cost locally — only that you used it.")
                    : "\(model.tokens.formatted()) tokens · \(Fmt.money(model.cost)) cost\n" + compositionTooltip(
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
                Text("Unavailable")
                    .font(.system(size: 9, weight: .medium, design: theme.fonts.bodyDesign))
                    .foregroundColor(theme.backgroundMode.secondaryTextColor)
                    .frame(width: 56, alignment: .trailing)
            } else {
                Text(Fmt.money(model.cost))
                    .font(.system(size: 10, weight: .semibold, design: .monospaced))
                    .foregroundColor(theme.costInk)
                    .frame(width: 56, alignment: .trailing)
            }
        }
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

/// Last-7-days chart. Style (line / bars / area) comes from
/// `bar.weekChartStyle` in config.json, switchable from the settings popover.
/// Data changes animate with a spring curve so new values glide into place
/// instead of snapping.
struct WeekSection: View {
    @ObservedObject var loader: TokmeterLoader
    @ObservedObject private var configStore = HubConfigStore.shared
    let theme: AppTheme

    /// 0→1 over ~0.9s on first appear. Drives a leading-edge mask so the
    /// chart reveals left-to-right like an ink pen drawing the line.
    @State private var drawProgress: CGFloat = 0
    @State private var hoveredDate: String?

    private var c: ThemeColors { theme.colors }
    private var style: WeekChartStyle { configStore.config.chartStyle }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(label: "LAST 7 RECORDED DAYS", count: loader.recentDaily.count, theme: theme)

            if loader.daemonPhase == .warming {
                ShimmerBar(width: 340, height: 60, breathToggle: true)
            } else if let custom = theme.skin?.spec.weekChart(
                days: loader.recentDaily, style: style, theme: theme) {
                custom
            } else {
                Chart(loader.recentDaily) { day in
                    if style == .bars {
                        BarMark(
                            x: .value("Date", day.date),
                            y: .value("Cost", day.cost)
                        )
                        .foregroundStyle(theme == .paper ? AnyShapeStyle(Broadsheet.ink) : AnyShapeStyle(LinearGradient(
                            colors: [c.accent, c.accent.opacity(0.45)],
                            startPoint: .top, endPoint: .bottom)))
                        .cornerRadius(theme == .paper ? 0 : 3)
                    } else if style == .area {
                        AreaMark(
                            x: .value("Date", day.date),
                            y: .value("Cost", day.cost)
                        )
                        .foregroundStyle(theme == .paper ? AnyShapeStyle(Broadsheet.ink.opacity(0.12)) : AnyShapeStyle(LinearGradient(
                            colors: [c.accent.opacity(0.55), c.accent.opacity(0.06)],
                            startPoint: .top, endPoint: .bottom)))
                        .interpolationMethod(.catmullRom)

                        LineMark(
                            x: .value("Date", day.date),
                            y: .value("Cost", day.cost)
                        )
                        .foregroundStyle(theme == .paper ? AnyShapeStyle(Broadsheet.ink) : AnyShapeStyle(LinearGradient(
                            colors: [c.accent, c.warm],
                            startPoint: .leading, endPoint: .trailing)))
                        .interpolationMethod(.catmullRom)
                        .lineStyle(StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                    } else {
                        LineMark(
                            x: .value("Date", day.date),
                            y: .value("Cost", day.cost)
                        )
                        .foregroundStyle(theme == .paper ? AnyShapeStyle(Broadsheet.ink) : AnyShapeStyle(LinearGradient(
                            colors: [c.accent, c.warm],
                            startPoint: .leading, endPoint: .trailing)))
                        .interpolationMethod(.catmullRom)
                        .lineStyle(StrokeStyle(lineWidth: theme == .paper ? 1.5 : 2.5, lineCap: .round, lineJoin: .round))

                        AreaMark(
                            x: .value("Date", day.date),
                            y: .value("Cost", day.cost)
                        )
                        .foregroundStyle(theme == .paper ? AnyShapeStyle(Color.clear) : AnyShapeStyle(LinearGradient(
                            colors: [c.accent.opacity(0.3), .clear],
                            startPoint: .top, endPoint: .bottom)))
                        .interpolationMethod(.catmullRom)
                    }

                    // Today, when it's among the recorded days, is the still-
                    // accumulating point — usually a flat tail next to full
                    // days, so give it a marker + its dollar reading or it
                    // reads as "no data for today". The last recorded day is
                    // not necessarily today; after a quiet day it isn't.
                    if LocalDay.isToday(day.date) {
                        PointMark(
                            x: .value("Date", day.date),
                            y: .value("Cost", day.cost)
                        )
                        .foregroundStyle(theme == .paper ? Broadsheet.ink : c.warm)
                        .symbolSize(style == .bars ? 0 : 28)
                        .annotation(position: .top, spacing: 3) {
                            Text(Fmt.cost(day.cost))
                                .font(theme == .paper
                                      ? Broadsheet.display(10, weight: .bold).monospacedDigit()
                                      : .system(size: 8, weight: .semibold, design: .rounded))
                                .foregroundColor(theme.backgroundMode.secondaryTextColor)
                        }
                    }
                }
                .frame(height: 60)
                .chartYAxis(.hidden)
                .chartXAxis {
                    AxisMarks { value in
                        AxisValueLabel {
                            Text(String((value.as(String.self) ?? "").suffix(5)))
                                .font(theme == .paper
                                      ? .system(size: 9, design: .serif).monospacedDigit()
                                      : .system(size: 9, design: .rounded))
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
                .animation(.spring(response: 0.5, dampingFraction: 0.80), value: style)
                .onAppear {
                    withAnimation(.easeOut(duration: 0.9)) { drawProgress = 1.0 }
                }
                .chartOverlay { proxy in
                    GeometryReader { geometry in
                        Color.clear.contentShape(Rectangle())
                            .onContinuousHover { phase in
                                switch phase {
                                case .active(let point):
                                    guard let anchor = proxy.plotFrame else { hoveredDate = nil; return }
                                    let frame = geometry[anchor]
                                    guard frame.contains(point) else { hoveredDate = nil; return }
                                    hoveredDate = proxy.value(atX: point.x - frame.minX, as: String.self)
                                case .ended: hoveredDate = nil
                                }
                            }
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if let day = loader.recentDaily.first(where: { $0.date == hoveredDate }) {
                        DailyUsageTooltip(day: day, theme: theme).offset(y: -30)
                    }
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
            SectionHeader(label: "TODAY’S PROJECTS", count: loader.todayProjects.count, theme: theme)

            if loader.daemonPhase == .warming {
                ForEach(0..<5, id: \.self) { _ in
                    ShimmerBar(width: 340, height: 28, breathToggle: true)
                }
            } else {
                let visible = showAll ? loader.todayProjects : Array(loader.todayProjects.prefix(8))
                ForEach(visible) { session in
                    row(session)
                }
                if loader.todayProjects.count > 8 && !showAll {
                    Button {
                        withAnimation(.spring(response: 0.5, dampingFraction: 0.85)) { showAll = true }
                    } label: {
                        HStack(spacing: 4) {
                            Text("Show all \(loader.todayProjects.count)")
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

        private var standardRow: some View {
            HStack(spacing: 10) {
                Circle().fill(c.secondary).frame(width: 6, height: 6)
                VStack(alignment: .leading, spacing: 1) {
                    Text(Fmt.projectBasename(session.project))
                        .font(.system(size: 12, weight: .medium, design: theme.fonts.bodyDesign))
                        .foregroundColor(theme.backgroundMode.primaryTextColor)
                        .lineLimit(1)
                        .help(session.project)
                    Text("\(Fmt.number(session.totalTokens)) tokens today")
                        .font(.system(size: 10, design: theme.fonts.bodyDesign))
                        .foregroundColor(theme.backgroundMode.secondaryTextColor)
                }
                Spacer()
                Text(Fmt.money(session.totalCost))
                    .font(.system(size: 12, weight: .semibold, design: .monospaced))
                    .foregroundColor(theme.costInk)
            }
        }

        /// `tokmeter ……………… $1.05` over a muted token line. Money in ink.
        private var broadsheetRow: some View {
            VStack(alignment: .leading, spacing: 1) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(Fmt.projectBasename(session.project))
                        .font(.system(size: 13, weight: .bold, design: .serif))
                        .foregroundColor(Broadsheet.ink)
                        .lineLimit(1)
                        .layoutPriority(1)
                        .help(session.project)
                    LeaderDots()
                    Text(Fmt.money(session.totalCost))
                        .font(.system(size: 13, weight: .heavy, design: .serif))
                        .monospacedDigit()
                        .foregroundColor(Broadsheet.ink)
                }
                Text("\(Fmt.number(session.totalTokens)) tokens today")
                    .font(.system(size: 10.5))
                    .foregroundColor(Broadsheet.muted)
            }
            .accessibilityElement(children: .combine)
        }

        var body: some View {
            Group {
                if let skin = theme.skin {
                    SkinProjectRow(skin: skin, project: session, theme: theme)
                } else if theme == .paper { broadsheetRow } else { standardRow }
            }
            .padding(.horizontal, theme == .paper || theme.skin != nil ? 0 : 10)
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

    /// Row background adapted per theme's card language — ruled on Paper,
    /// black+green-border on Terminal, material on Glass, etc.
    @ViewBuilder
    private var rowBackground: some View {
        let radius: CGFloat = 8
        switch theme.cardMode {
        case .skin:
            Color.clear // the skin's ProjectRow draws its own chrome
        case .lightPaper:
            RoundedRectangle(cornerRadius: radius)
                .fill(Color.white)
                .shadow(color: Color.black.opacity(0.04), radius: 3, x: 0, y: 1)
        case .paperHairline:
            Rectangle().fill(Color.clear)
                .overlay(alignment: .bottom) {
                    Rectangle().fill(Broadsheet.ink.opacity(0.25)).frame(height: 0.5)
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
            FrostedGlassPanel(cornerRadius: radius)
        default:
            RoundedRectangle(cornerRadius: radius).fill(Color.gray.opacity(0.10))
        }
    }
}
