// TokmeterBarView.swift — the popover content shown when the menubar icon is clicked.
//
// UX principles:
//   - Hero element (today's cost) commands the eye via size + breathing gradient.
//   - Centered stat cards: value on top, label below — clean scannable layout.
//   - Skeleton shimmer instead of "0" zeros while the daemon warms up.
//   - Theme system: every color flows from AppTheme.colors — switch in Settings.
//   - Animated transitions between states (warming → ready → stale).
//   - Sessions list scrolls — handles 10/20/50+ projects without truncation.
//   - Clear visual hierarchy: hero / details / sessions / footer.

import Charts
import SwiftUI

// MARK: - Typography tokens

private enum Typography {
    static let hero      = Font.system(size: 44, weight: .bold,    design: .rounded)
    static let statValue = Font.system(size: 20, weight: .bold,    design: .rounded)
    static let label     = Font.system(size: 11, weight: .medium,   design: .rounded)
    static let bodyMono  = Font.system(size: 12, weight: .regular,  design: .monospaced)
}

// MARK: - Main view

struct TokmeterBarView: View {
    @ObservedObject var loader: TokmeterLoader
    @ObservedObject var updater: UpdaterController
    @Environment(\.colorScheme) private var colorScheme

    // Persisted theme — drives every color in the UI
    @AppStorage("appTheme") var theme: AppTheme = .twilight
    private var c: ThemeColors { theme.colors }

    // Local UI state — not persisted
    @State private var showAllSessions = false
    @State private var breathToggle = false
    @State private var heartbeatPhase: CGFloat = 0
    @State private var showSettings = false

    private var cardFillOpacity: Double { colorScheme == .light ? 0.12 : 0.08 }
    private var rowFillOpacity: Double { colorScheme == .light ? 0.10 : 0.06 }

    private var appVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.1.0"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            heroHeader

            errorBanner
                .padding(.horizontal, 16)
                .padding(.top, 8)

            ScrollView(.vertical, showsIndicators: true) {
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
                .padding(.top, 12)
                .padding(.bottom, 10)
            }

            Divider().opacity(0.3)

            footer
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
        }
        .frame(width: 380)
        .frame(maxHeight: 580)
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
        .onAppear {
            breathToggle = true
            withAnimation(.easeInOut(duration: 0.8).repeatForever(autoreverses: true)) {
                heartbeatPhase = 1
            }
        }
    }

    // MARK: - Hero header

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
            notchShape
                .fill(
                    LinearGradient(
                        colors: [c.primary, c.secondary, c.highlight],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .overlay(
                    notchShape
                        .fill(Color.white)
                        .opacity(breathToggle ? 0.08 : 0)
                        .animation(.easeInOut(duration: 4).repeatForever(autoreverses: true), value: breathToggle)
                )
                .overlay(
                    notchShape
                        .stroke(Color.white.opacity(0.12), lineWidth: 1)
                )
                .shadow(color: c.secondary.opacity(0.45), radius: 14, x: 0, y: 8)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .center, spacing: 8) {
                    Text("♾️")
                        .font(.system(size: 28))
                        .scaleEffect(breathToggle ? 1.05 : 1.0)
                        .animation(.easeInOut(duration: 4).repeatForever(autoreverses: true), value: breathToggle)
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
                .opacity(breathToggle ? 1 : 0.5)
                .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: breathToggle)
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
            HStack(spacing: 6) {
                Image(systemName: "bolt.trianglebadge.exclamationmark.fill")
                    .foregroundColor(.orange)
                    .font(.system(size: 12))
                Text(shortError(error))
                    .font(.system(size: 10, weight: .medium, design: .rounded))
                    .foregroundColor(.primary.opacity(0.8))
                    .lineLimit(1)
                    .help(error)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule().fill(Color.orange.opacity(0.12))
            )
            .padding(.bottom, 4)
            .accessibilityElement(children: .combine)
        }
    }

    private func shortError(_ error: String) -> String {
        if error.contains("not running") { return "Daemon offline — using cached data" }
        if error.contains("timed out") { return "Scan timed out — retrying…" }
        if error.contains("Network") { return "Network error — using cached data" }
        let first = error.prefix(50)
        return first.count < error.count ? "\(first)…" : error
    }

    // MARK: - Stats grid (centered cards — value on top, label below)

    private var statsGrid: some View {
        HStack(spacing: 8) {
            statCard(
                label: "TOKENS",
                value: formatNumber(loader.totalTokens),
                color: c.secondary
            )
            statCard(
                label: "SPENT",
                value: formatCost(loader.totalCost),
                color: c.highlight
            )
            if let s = loader.stats {
                statCard(
                    label: "STREAK",
                    value: "\(s.longestStreak)d",
                    color: c.tertiary
                )
            }
        }
    }

    private func statCard(label: String, value: String, color: Color) -> some View {
        VStack(spacing: 4) {
            if loader.isWarming {
                shimmerBar(width: 60, height: 20)
            } else {
                Text(value)
                    .font(Typography.statValue)
                    .foregroundColor(color)
                    .contentTransition(.numericText())
            }
            Text(label)
                .font(.system(size: 9, weight: .medium, design: .rounded))
                .tracking(0.5)
                .foregroundColor(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: 12)
                .fill(color.opacity(cardFillOpacity))
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
                        HStack(spacing: 3) {
                            Image(systemName: "waveform.circle")
                                .font(.system(size: 10))
                                .foregroundColor(c.accent)
                            Text(shortModelName(model.model))
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .lineLimit(1)
                        }
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
                                                    colors: [c.secondary, c.warm],
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
                            .foregroundColor(c.highlight)
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
                            colors: [c.accent, c.warm],
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
                            colors: [c.accent.opacity(0.3), .clear],
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
                        .foregroundColor(c.accent)
                    }
                    .buttonStyle(.borderless)
                    .padding(.top, 4)
                }
            }
        }
    }

    private func sessionRow(_ session: ProjectData) -> some View {
        HStack(spacing: 10) {
            Circle()
                .fill(c.secondary)
                .frame(width: 6, height: 6)
            VStack(alignment: .leading, spacing: 1) {
                Text(projectBasename(session.project))
                    .font(.system(size: 12, weight: .medium, design: .rounded))
                    .lineLimit(1)
                    .help(session.project)
                Text("\(session.activeDays)d  ·  \(formatNumber(session.totalTokens)) tokens")
                    .font(.system(size: 10, design: .rounded))
                    .foregroundColor(.secondary)
            }
            Spacer()
            Text(formatCost(session.totalCost))
                .font(.system(size: 12, weight: .semibold, design: .monospaced))
                .foregroundColor(c.highlight)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(
            RoundedRectangle(cornerRadius: 8)
                .fill(Color.gray.opacity(rowFillOpacity))
        )
    }

    private func projectBasename(_ path: String) -> String {
        let trimmed = path.trimmingCharacters(in: CharacterSet(charactersIn: "/\\ "))
        let segments = trimmed.split { $0 == "/" || $0 == "\\" }
        return segments.last.map(String.init) ?? path
    }

    // MARK: - Footer

    private var footer: some View {
        VStack(spacing: 6) {
            HStack(spacing: 4) {
                Text("Built by sriinnu")
                    .font(.system(size: 10, design: .rounded))
                    .foregroundColor(.secondary)
                    .onTapGesture { NSWorkspace.shared.open(URL(string: "https://github.com/sriinnu")!) }
                Text("·")
                    .font(.system(size: 10))
                    .foregroundColor(.secondary)
                Text("v\(appVersion)")
                    .font(.system(size: 10, design: .rounded))
                    .foregroundColor(.secondary)
                Spacer()
            }

            HStack(spacing: 10) {
                daemonHeartbeat

                Button(action: { Task { await loader.loadData() } }) {
                    Label(loader.isLoading ? "Refreshing…" : "Refresh", systemImage: "arrow.clockwise")
                        .font(.system(size: 11, design: .rounded))
                }
                .buttonStyle(.borderless)
                .foregroundColor(.secondary)
                .disabled(loader.isLoading)
                .accessibilityLabel("Refresh data")

                Spacer()

                Button(action: { showSettings.toggle() }) {
                    Image(systemName: "gearshape")
                        .font(.system(size: 12))
                }
                .buttonStyle(.borderless)
                .foregroundColor(.secondary)
                .help("Settings")
                .popover(isPresented: $showSettings) {
                    settingsPopover
                }

                Button(action: { updater.checkForUpdates() }) {
                    Image(systemName: "arrow.down.circle")
                        .font(.system(size: 12))
                }
                .buttonStyle(.borderless)
                .foregroundColor(.secondary)
                .disabled(!updater.canCheckForUpdates)
                .accessibilityLabel("Check for updates")
                .help("Check for updates")

                Button(action: { NSApplication.shared.terminate(nil) }) {
                    Image(systemName: "power")
                        .font(.system(size: 12))
                }
                .buttonStyle(.borderless)
                .foregroundColor(.secondary)
                .help("Quit Tokmeter")
            }
        }
    }

    // MARK: - Settings popover

    private var settingsPopover: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Settings")
                .font(.system(size: 13, weight: .semibold, design: .rounded))

            // Theme picker — colored swatches with labels
            VStack(alignment: .leading, spacing: 8) {
                Text("Theme")
                    .font(.system(size: 11, weight: .medium, design: .rounded))
                HStack(spacing: 10) {
                    ForEach(AppTheme.allCases) { t in
                        Button {
                            theme = t
                        } label: {
                            VStack(spacing: 3) {
                                ZStack {
                                    Circle()
                                        .fill(t.colors.secondary)
                                        .frame(width: 22, height: 22)
                                    Image(systemName: t.icon)
                                        .font(.system(size: 9, weight: .bold))
                                        .foregroundColor(.white.opacity(0.9))
                                }
                                .overlay(
                                    Circle()
                                        .stroke(theme == t ? t.colors.accent : Color.clear, lineWidth: 2)
                                )
                                Text(t.displayName)
                                    .font(.system(size: 8, weight: .medium, design: .rounded))
                                    .foregroundColor(theme == t ? .primary : .secondary)
                            }
                        }
                        .buttonStyle(.borderless)
                    }
                }
            }

            Divider()

            HStack {
                Text("Refresh interval")
                    .font(.system(size: 11, design: .rounded))
                Spacer()
                Text("30s")
                    .font(.system(size: 11, design: .rounded))
                    .foregroundColor(.secondary)
            }

            Divider()

            Button(action: {
                let configPath = NSHomeDirectory() + "/.tokmeter/config.json"
                NSWorkspace.shared.open(URL(fileURLWithPath: configPath))
            }) {
                Label("Open Config File", systemImage: "doc.text")
                    .font(.system(size: 11, design: .rounded))
            }
            .buttonStyle(.borderless)
        }
        .padding(14)
        .frame(width: 220)
    }

    // MARK: - Daemon heartbeat

    private var daemonHeartbeat: some View {
        let isAlive = loader.isDaemonAlive
        return HStack(spacing: 4) {
            Circle()
                .fill(isAlive ? Color.green : Color.red)
                .frame(width: 7, height: 7)
                .shadow(color: isAlive ? .green.opacity(0.6) : .clear, radius: 4)
                .scaleEffect(isAlive ? (1.0 + heartbeatPhase * 0.3) : 1.0)
            Text(isAlive ? "Live" : "Offline")
                .font(.system(size: 9, weight: .semibold, design: .rounded))
                .foregroundColor(isAlive ? .green : .red.opacity(0.8))
        }
        .accessibilityLabel(isAlive ? "Daemon running" : "Daemon offline")
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
            .opacity(breathToggle ? 0.7 : 0.3)
            .animation(.easeInOut(duration: 1.5).repeatForever(autoreverses: true), value: breathToggle)
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
        if let range = name.range(of: #"-\d{8}$"#, options: .regularExpression) {
            name = String(name[..<range.lowerBound])
        }
        return name
    }
}
