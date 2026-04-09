// TokmeterBarView.swift — the popover content shown when the menubar icon is clicked.
//
// Layout:
//   - Header: Tokmeter brand + refresh button + error chip
//   - Stats grid: Today / Total Tokens / Total Cost
//   - Top models bar chart
//   - 7-day cost line chart
//   - Quick stats: projects / active days / streak
//   - Quit button

import Charts
import SwiftUI

struct TokmeterBarView: View {
    @ObservedObject var loader: TokmeterLoader

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            errorBanner
            Divider()
            statsGrid
                .opacity(loader.lastError != nil && loader.hasFreshData ? 0.5 : 1.0)

            if !loader.topModels.isEmpty {
                Divider()
                topModelsChart
            }

            if loader.recentDaily.count > 1 {
                Divider()
                weekChart
            }

            if let stats = loader.stats {
                Divider()
                quickStats(stats: stats)
            }

            Divider()

            Button("Quit Tokmeter") {
                NSApplication.shared.terminate(nil)
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .foregroundColor(.secondary)
        }
        .padding()
        .frame(width: 360)
    }

    // MARK: - Sections

    private var header: some View {
        HStack {
            Text("【♾️】 Tokmeter")
                .font(.headline)
                .foregroundColor(Color(red: 0.55, green: 0.36, blue: 0.96)) // twilight violet
                .accessibilityLabel("Tokmeter")

            if loader.lastError != nil && loader.hasFreshData {
                // We have stale numbers visible — flag them
                Text("STALE")
                    .font(.caption2)
                    .padding(.horizontal, 4)
                    .padding(.vertical, 1)
                    .background(Color.orange.opacity(0.2))
                    .foregroundColor(.orange)
                    .cornerRadius(3)
                    .accessibilityLabel("Data is stale")
            }

            Spacer()

            Button(action: { Task { await loader.loadData() } }) {
                Image(systemName: loader.isLoading ? "arrow.triangle.2.circlepath" : "arrow.clockwise")
            }
            .buttonStyle(.borderless)
            .font(.caption)
            .disabled(loader.isLoading)
            .accessibilityLabel("Refresh")
        }
    }

    /// Full error block — shown below the header when offline so the user
    /// can actually read it (the old .help() tooltip was undiscoverable).
    @ViewBuilder
    private var errorBanner: some View {
        if let error = loader.lastError {
            HStack(alignment: .top, spacing: 6) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundColor(.orange)
                Text(error)
                    .font(.caption)
                    .foregroundColor(.primary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(8)
            .background(Color.orange.opacity(0.1))
            .cornerRadius(6)
            .accessibilityElement(children: .combine)
        }
    }

    private var statsGrid: some View {
        HStack(spacing: 20) {
            statBlock(label: "Today", value: String(format: "$%.2f", loader.todayCost))
            statBlock(label: "Total Tokens", value: formatNumber(loader.totalTokens))
            statBlock(label: "Total Cost", value: String(format: "$%.2f", loader.totalCost))
        }
    }

    private func statBlock(label: String, value: String) -> some View {
        VStack(alignment: .leading) {
            Text(label)
                .font(.caption)
                .foregroundColor(.secondary)
            Text(value)
                .font(.title2)
                .fontWeight(.bold)
        }
    }

    private var topModelsChart: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Top Models")
                .font(.caption)
                .foregroundColor(.secondary)

            Chart(loader.topModels) { model in
                BarMark(
                    x: .value("Cost", model.cost),
                    y: .value("Model", model.model)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color(red: 0.55, green: 0.36, blue: 0.96), Color(red: 0.71, green: 0.32, blue: 0.04)],
                        startPoint: .leading,
                        endPoint: .trailing
                    )
                )
            }
            .frame(height: 80)
            .chartXAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        Text(String(format: "$%.1f", value.as(Double.self) ?? 0))
                            .font(.caption2)
                    }
                }
            }
        }
    }

    private var weekChart: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Last 7 Days")
                .font(.caption)
                .foregroundColor(.secondary)

            Chart(loader.recentDaily) { day in
                LineMark(
                    x: .value("Date", String(day.date.suffix(5))),
                    y: .value("Cost", day.cost)
                )
                .foregroundStyle(Color(red: 0.71, green: 0.32, blue: 0.04)) // amber
                .interpolationMethod(.catmullRom)
                .lineStyle(StrokeStyle(lineWidth: 2))

                AreaMark(
                    x: .value("Date", String(day.date.suffix(5))),
                    y: .value("Cost", day.cost)
                )
                .foregroundStyle(
                    LinearGradient(
                        colors: [Color(red: 0.71, green: 0.32, blue: 0.04).opacity(0.3), .clear],
                        startPoint: .top,
                        endPoint: .bottom
                    )
                )
                .interpolationMethod(.catmullRom)
            }
            .frame(height: 60)
            .chartYAxis {
                AxisMarks { value in
                    AxisValueLabel {
                        Text(String(format: "$%.0f", value.as(Double.self) ?? 0))
                            .font(.caption2)
                    }
                }
            }
        }
    }

    private func quickStats(stats: StatsData) -> some View {
        HStack(spacing: 16) {
            quickStat(label: "Projects", value: "\(stats.projects)")
            quickStat(label: "Active Days", value: "\(stats.activeDays)")
            quickStat(label: "Streak", value: "\(stats.longestStreak)d")
        }
    }

    private func quickStat(label: String, value: String) -> some View {
        VStack(alignment: .leading) {
            Text(label)
                .font(.caption2)
                .foregroundColor(.secondary)
            Text(value)
                .font(.caption)
                .fontWeight(.semibold)
        }
    }

    // MARK: - Helpers

    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000_000 { return String(format: "%.1fB", Double(n) / 1_000_000_000) }
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}
