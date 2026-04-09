// TokmeterBarView.swift — the popover content shown when the menubar icon is clicked.
//
// Disney/Pixar UX rules applied:
//   - Hero element (today's cost) commands the eye via size + breathing gradient.
//   - Skeleton shimmer instead of "0" zeros while the daemon warms up.
//   - Color story flows: indigo → violet → amber across the layout.
//   - Animated transitions between states (warming → ready → stale).
//   - Sessions list scrolls — handles 10/20/50+ projects without truncation.
//   - Every loading/error/empty state has personality, not generic placeholders.
//   - Clear visual hierarchy: hero / details / sessions / footer.

import Charts
import SwiftUI

// MARK: - Shared design tokens

private enum Palette {
    static let twilightIndigo = Color(red: 0.263, green: 0.220, blue: 0.792)  // #4338ca
    static let twilightViolet = Color(red: 0.427, green: 0.157, blue: 0.851)  // #6d28d9
    static let twilightBright = Color(red: 0.545, green: 0.361, blue: 0.965)  // #8b5cf6
    static let amber          = Color(red: 0.706, green: 0.325, blue: 0.035)  // #b45309
    static let amberWarm      = Color(red: 0.961, green: 0.690, blue: 0.255)  // #f5b041
    static let teal           = Color(red: 0.059, green: 0.463, blue: 0.431)  // #0f766e
    static let slate          = Color(red: 0.278, green: 0.333, blue: 0.412)  // #475569
}

private enum Typography {
    static let hero      = Font.system(size: 44, weight: .bold,    design: .rounded)
    static let big       = Font.system(size: 22, weight: .semibold, design: .rounded)
    static let label     = Font.system(size: 11, weight: .medium,   design: .rounded)
    static let bodyMono  = Font.system(size: 12, weight: .regular,  design: .monospaced)
}

// MARK: - Main view

struct TokmeterBarView: View {
    @ObservedObject var loader: TokmeterLoader
    @ObservedObject var updater: UpdaterController

    // Local UI state — not persisted
    @State private var showAllSessions = false
    @State private var phase: CGFloat = 0  // breathing gradient phase

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Hero is flush with the popover edges and "hangs" from the top
            // like a macOS notch widget — rounded only on the bottom corners.
            heroHeader

            errorBanner
                .padding(.horizontal, 16)
                .padding(.top, 12)

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    statsGrid
                    if !loader.topModels.isEmpty || loader.isWarming {
                        modelsSection
                    }
                    if loader.recentDaily.count > 1 || loader.isWarming {
                        weekSection
                    }
                    if !loader.sessions.isEmpty || loader.isWarming {
                        sessionsSection
                    }
                }
                .padding(.horizontal, 16)
                .padding(.top, 14)
                .padding(.bottom, 16)
            }
            .frame(maxHeight: 440)

            Divider().opacity(0.3)

            footer
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
        }
        .frame(width: 380)
        .background(
            LinearGradient(
                colors: [
                    Color(NSColor.windowBackgroundColor),
                    Color(NSColor.windowBackgroundColor).opacity(0.95),
                ],
                startPoint: .top,
                endPoint: .bottom
            )
        )
        // Breathing gradient animation — drives the hero header background
        .onAppear {
            withAnimation(.easeInOut(duration: 4).repeatForever(autoreverses: true)) {
                phase = 1
            }
        }
    }

    // MARK: - Hero header (macOS notch-widget aesthetic)

    /// The notch shape: top edges flush with the popover top, deeply rounded
    /// bottom corners. Visually "hangs" from the top of the window like
    /// macOS's Dynamic Island / top-notch widgets.
    private var notchShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            cornerRadii: .init(
                topLeading: 0,
                bottomLeading: 24,
                bottomTrailing: 24,
                topTrailing: 0
            ),
            style: .continuous
        )
    }

    private var heroHeader: some View {
        ZStack(alignment: .topLeading) {
            // Breathing twilight gradient — the entire app's color story
            // distilled into one block. The notch shape is its container.
            notchShape
                .fill(
                    LinearGradient(
                        colors: [
                            Palette.twilightIndigo,
                            Palette.twilightViolet.interpolated(to: Palette.twilightBright, fraction: phase),
                            Palette.amber,
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(
                    // Hairline inner stroke at the bottom curve — gives the
                    // notch a subtle "lit edge" without competing with the gradient
                    notchShape
                        .stroke(Color.white.opacity(0.12), lineWidth: 1)
                )
                // Soft drop shadow below — sells the "hanging" depth
                .shadow(color: Palette.twilightViolet.opacity(0.45), radius: 14, x: 0, y: 8)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 8) {
                    Text("♾️")
                        .font(.system(size: 28))
                        .scaleEffect(1 + phase * 0.05)  // breathing
                    Text("TOKMETER")
                        .font(.system(size: 11, weight: .heavy, design: .rounded))
                        .tracking(2.5)
                        .foregroundColor(.white.opacity(0.85))
                    Spacer()
                    if loader.isWarming {
                        warmingPill
                    } else if loader.lastError != nil && loader.hasFreshData {
                        stalePill
                    }
                }

                if loader.isWarming {
                    skeletonHero
                } else {
                    Text(formatCost(loader.todayCost))
                        .font(Typography.hero)
                        .foregroundColor(.white)
                        .contentTransition(.numericText())
                        .animation(.easeOut(duration: 0.4), value: loader.todayCost)
                    Text("today")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .italic()
                        .foregroundColor(.white.opacity(0.7))
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 22)
        }
    }

    private var skeletonHero: some View {
        VStack(alignment: .leading, spacing: 4) {
            shimmerBar(width: 140, height: 32)
            shimmerBar(width: 60, height: 12)
        }
    }

    private var warmingPill: some View {
        HStack(spacing: 4) {
            Circle()
                .fill(.white)
                .frame(width: 6, height: 6)
                .opacity(0.5 + phase * 0.5)
            Text("WARMING")
                .font(.system(size: 9, weight: .heavy, design: .rounded))
                .tracking(1)
                .foregroundColor(.white)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 3)
        .background(Capsule().fill(Color.white.opacity(0.18)))
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

    // MARK: - Error banner

    @ViewBuilder
    private var errorBanner: some View {
        if let error = loader.lastError, !loader.isWarming {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.orange)
                    .font(.caption)
                Text(error)
                    .font(.system(size: 11, design: .rounded))
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(10)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color.orange.opacity(0.12))
            )
            .padding(.bottom, 8)
            .accessibilityElement(children: .combine)
        }
    }

    // MARK: - Stats grid

    private var statsGrid: some View {
        HStack(spacing: 10) {
            statCard(
                label: "TOTAL TOKENS",
                value: formatNumber(loader.totalTokens),
                color: Palette.twilightViolet
            )
            statCard(
                label: "TOTAL SPENT",
                value: formatCost(loader.totalCost),
                color: Palette.amber
            )
            if let s = loader.stats {
                statCard(
                    label: "STREAK",
                    value: "\(s.longestStreak)d",
                    color: Palette.teal
                )
            }
        }
    }

    private func statCard(label: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(label)
                .font(Typography.label)
                .tracking(0.8)
                .foregroundColor(.secondary)
            if loader.isWarming {
                shimmerBar(width: 60, height: 18)
            } else {
                Text(value)
                    .font(Typography.big)
                    .foregroundColor(color)
                    .contentTransition(.numericText())
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(color.opacity(0.08))
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .stroke(color.opacity(0.2), lineWidth: 1)
                )
        )
    }

    // MARK: - Models section

    @ViewBuilder
    private var modelsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("TOP MODELS", count: loader.topModels.count)

            if loader.isWarming {
                ForEach(0..<3, id: \.self) { _ in
                    shimmerBar(width: 280, height: 14)
                }
            } else {
                let maxCost = loader.topModels.first?.cost ?? 1
                ForEach(loader.topModels) { model in
                    HStack(spacing: 8) {
                        Text(shortModelName(model.model))
                            .font(.system(size: 11, weight: .medium, design: .monospaced))
                            .lineLimit(1)
                            .frame(width: 110, alignment: .leading)
                        GeometryReader { geo in
                            let pct = CGFloat(min(model.cost / max(maxCost, 0.01), 1.0))
                            Capsule()
                                .fill(Color.gray.opacity(0.12))
                                .overlay(
                                    HStack {
                                        Capsule()
                                            .fill(
                                                LinearGradient(
                                                    colors: [Palette.twilightViolet, Palette.amberWarm],
                                                    startPoint: .leading,
                                                    endPoint: .trailing
                                                )
                                            )
                                            .frame(width: max(geo.size.width * pct, 4))
                                        Spacer(minLength: 0)
                                    }
                                )
                                .frame(height: 6)
                        }
                        .frame(height: 6)
                        Text(formatCost(model.cost))
                            .font(.system(size: 10, weight: .semibold, design: .monospaced))
                            .foregroundColor(Palette.amber)
                            .frame(width: 56, alignment: .trailing)
                    }
                }
            }
        }
    }

    // MARK: - Week chart

    @ViewBuilder
    private var weekSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("LAST 7 DAYS", count: loader.recentDaily.count)

            if loader.isWarming {
                shimmerBar(width: 340, height: 60)
            } else {
                Chart(loader.recentDaily) { day in
                    LineMark(
                        x: .value("Date", String(day.date.suffix(5))),
                        y: .value("Cost", day.cost)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Palette.twilightBright, Palette.amberWarm],
                            startPoint: .leading,
                            endPoint: .trailing
                        )
                    )
                    .interpolationMethod(.catmullRom)
                    .lineStyle(StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))

                    AreaMark(
                        x: .value("Date", String(day.date.suffix(5))),
                        y: .value("Cost", day.cost)
                    )
                    .foregroundStyle(
                        LinearGradient(
                            colors: [Palette.twilightBright.opacity(0.3), .clear],
                            startPoint: .top,
                            endPoint: .bottom
                        )
                    )
                    .interpolationMethod(.catmullRom)
                }
                .frame(height: 60)
                .chartYAxis(.hidden)
                .chartXAxis {
                    AxisMarks { value in
                        AxisValueLabel {
                            Text(value.as(String.self) ?? "")
                                .font(.system(size: 9, design: .rounded))
                                .foregroundColor(.secondary)
                        }
                    }
                }
            }
        }
    }

    // MARK: - Sessions list

    @ViewBuilder
    private var sessionsSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            sectionHeader("SESSIONS", count: loader.sessions.count)

            if loader.isWarming {
                ForEach(0..<5, id: \.self) { _ in
                    shimmerBar(width: 340, height: 28)
                }
            } else {
                let visible = showAllSessions
                    ? loader.sessions
                    : Array(loader.sessions.prefix(8))
                ForEach(visible) { session in
                    sessionRow(session)
                }
                if loader.sessions.count > 8 && !showAllSessions {
                    Button {
                        withAnimation(.easeOut(duration: 0.25)) {
                            showAllSessions = true
                        }
                    } label: {
                        HStack(spacing: 4) {
                            Text("Show all \(loader.sessions.count)")
                                .font(.system(size: 11, weight: .medium, design: .rounded))
                            Image(systemName: "chevron.down")
                                .font(.system(size: 9))
                        }
                        .foregroundColor(Palette.twilightBright)
                    }
                    .buttonStyle(.borderless)
                    .padding(.top, 4)
                }
            }
        }
    }

    private func sessionRow(_ session: ProjectData) -> some View {
        HStack(spacing: 10) {
            // Provider color chip
            Circle()
                .fill(Palette.twilightViolet)
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(projectBasename(session.project))
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .lineLimit(1)
                    .help(session.project)  // tooltip shows full path on hover
                Text("\(session.activeDays)d  ·  \(formatNumber(session.totalTokens)) tokens")
                    .font(.system(size: 10, design: .rounded))
                    .foregroundColor(.secondary)
            }
            Spacer()
            Text(formatCost(session.totalCost))
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(Palette.amber)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.gray.opacity(0.06))
        )
    }

    /// Strip the directory path from a project identifier — show just the
    /// last meaningful segment. Works for both Unix (/) and Windows (\)
    /// paths and trims trailing separators. Hover over the row to see the
    /// full path via the .help() tooltip.
    private func projectBasename(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/\\ "))
        let segments = trimmed.split { $0 == "/" || $0 == "\\" }
        return segments.last.map(String.init) ?? path
    }

    // MARK: - Footer

    private var footer: some View {
        HStack(spacing: 14) {
            Button(action: { Task { await loader.loadData() } }) {
                Label(loader.isLoading ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)
            .foregroundColor(.secondary)
            .disabled(loader.isLoading)
            .accessibilityLabel("Refresh data")

            Button(action: { updater.checkForUpdates() }) {
                Label("Updates", systemImage: "arrow.down.circle")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)
            .foregroundColor(.secondary)
            .disabled(!updater.canCheckForUpdates)
            .accessibilityLabel("Check for updates")

            Spacer()

            Button(action: { NSApplication.shared.terminate(nil) }) {
                Label("Quit", systemImage: "power")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)
            .foregroundColor(.secondary)
        }
    }

    // MARK: - Helpers

    private func sectionHeader(_ label: String, count: Int) -> some View {
        HStack {
            Text(label)
                .font(Typography.label)
                .tracking(1.2)
                .foregroundColor(.secondary)
            if count > 0 {
                Text("\(count)")
                    .font(.system(size: 10, weight: .semibold, design: .rounded))
                    .foregroundColor(.secondary)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Capsule().fill(Color.gray.opacity(0.15)))
            }
            Spacer()
        }
    }

    private func shimmerBar(width: CGFloat, height: CGFloat) -> some View {
        RoundedRectangle(cornerRadius: height / 3)
            .fill(
                LinearGradient(
                    colors: [
                        Color.gray.opacity(0.15),
                        Color.gray.opacity(0.25),
                        Color.gray.opacity(0.15),
                    ],
                    startPoint: .leading,
                    endPoint: .trailing
                )
            )
            .frame(width: width, height: height)
            .opacity(0.5 + phase * 0.5)
    }

    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", Double(n) / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }

    private func formatCost(_ cost: Double) -> String {
        if cost >= 10_000 { return String(format: "$%.0fK", cost / 1000) }
        if cost >= 1000 { return String(format: "$%.1fK", cost / 1000) }
        if cost >= 100 { return String(format: "$%.0f", cost) }
        return String(format: "$%.2f", cost)
    }

    private func shortModelName(_ id: String) -> String {
        var name = id
        if name.hasPrefix("claude-") { name = String(name.dropFirst(7)) }
        // Strip date suffix
        if let range = name.range(of: #"-\d{8}$"#, options: .regularExpression) {
            name = String(name[..<range.lowerBound])
        }
        return name
    }
}

// MARK: - Color helper

private extension Color {
    /// Linearly interpolates this color towards another by a fraction in [0, 1].
    func interpolated(to other: Color, fraction: CGFloat) -> Color {
        let t = max(0, min(1, fraction))
        let a = NSColor(self).usingColorSpace(.sRGB)!
        let b = NSColor(other).usingColorSpace(.sRGB)!
        return Color(
            red: Double(a.redComponent + (b.redComponent - a.redComponent) * t),
            green: Double(a.greenComponent + (b.greenComponent - a.greenComponent) * t),
            blue: Double(a.blueComponent + (b.blueComponent - a.blueComponent) * t)
        )
    }
}
