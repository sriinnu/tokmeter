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
struct ModelsSection: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

    private var c: ThemeColors { theme.colors }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            SectionHeader(label: "TOP MODELS", count: loader.topModels.count, theme: theme)

            if loader.isWarming {
                ForEach(0..<3, id: \.self) { _ in
                    ShimmerBar(width: 280, height: 14, breathToggle: true)
                }
            } else {
                let maxCost = loader.topModels.first?.cost ?? 1
                ForEach(loader.topModels) { model in
                    modelRow(model, maxCost: maxCost)
                }
            }
        }
    }

    private func modelRow(_ model: ModelUsage, maxCost: Double) -> some View {
        HStack(spacing: 8) {
            HStack(spacing: 3) {
                Image(systemName: "waveform.circle")
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
                                .fill(LinearGradient(
                                    colors: [c.secondary, c.warm],
                                    startPoint: .leading, endPoint: .trailing))
                                .frame(width: max(geo.size.width * pct, 4))
                            Spacer(minLength: 0)
                        }
                    )
                    .frame(height: 6)
                    .animation(.spring(response: 0.6, dampingFraction: 0.75), value: model.cost)
            }
            .frame(height: 6)
            Text(Fmt.cost(model.cost))
                .font(.system(size: 10, weight: .semibold, design: .monospaced))
                .foregroundColor(c.highlight)
                .frame(width: 56, alignment: .trailing)
        }
    }
}

// MARK: - Week section

/// Last-7-days line chart. Data changes animate with a spring curve so new
/// values glide into place instead of snapping.
struct WeekSection: View {
    @ObservedObject var loader: TokmeterLoader
    let theme: AppTheme

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
                .animation(.spring(response: 0.7, dampingFraction: 0.80), value: loader.recentDaily.map(\.cost))
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
        .background(rowBackground)
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
