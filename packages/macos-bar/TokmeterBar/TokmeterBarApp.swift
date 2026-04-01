import SwiftUI
import Charts
import Foundation

// MARK: - Data Models

struct DailyUsage: Identifiable {
    let id = UUID()
    let date: String
    let tokens: Int
    let cost: Double
}

struct ModelUsage: Identifiable {
    let id = UUID()
    let model: String
    let cost: Double
    let tokens: Int
}

struct TokmeterData: Codable {
    let stats: StatsData
    let daily: [DailyData]
    let models: [ModelData]
}

struct StatsData: Codable {
    let totalCost: Double
    let totalTokens: Int
    let activeDays: Int
    let projects: Int
    let longestStreak: Int
}

struct DailyData: Codable {
    let date: String
    let totalTokens: Int
    let cost: Double
}

struct ModelData: Codable {
    let model: String
    let cost: Double
    let totalTokens: Int
    let percentageOfTotal: Double
}

// MARK: - Data Loader

class TokmeterLoader: ObservableObject {
    @Published var data: TokmeterData?
    @Published var totalCost: Double = 0
    @Published var totalTokens: Int = 0
    @Published var todayCost: Double = 0
    @Published var todayTokens: Int = 0
    @Published var topModels: [ModelUsage] = []
    @Published var recentDaily: [DailyUsage] = []
    @Published var lastError: String?

    private let dataPath: String
    private var timer: Timer?

    init() {
        self.dataPath = NSHomeDirectory() + "/.tokmeter/live.json"
        loadData()
        // Refresh every 60 seconds
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            self?.loadData()
        }
    }

    deinit {
        timer?.invalidate()
    }

    func loadData() {
        let fileURL = URL(fileURLWithPath: dataPath)

        guard FileManager.default.fileExists(atPath: dataPath) else {
            // Data file does not exist yet — try generating it
            generateData()
            return
        }

        do {
            let rawData = try Data(contentsOf: fileURL)
            let decoded = try JSONDecoder().decode(TokmeterData.self, from: rawData)
            DispatchQueue.main.async { [weak self] in
                guard let self = self else { return }
                self.data = decoded
                self.totalCost = decoded.stats.totalCost
                self.totalTokens = decoded.stats.totalTokens
                self.lastError = nil

                // Derive "today" values from the most recent daily entry
                if let today = decoded.daily.last {
                    self.todayCost = today.cost
                    self.todayTokens = today.totalTokens
                } else {
                    self.todayCost = 0
                    self.todayTokens = 0
                }

                self.topModels = decoded.models.prefix(3).map {
                    ModelUsage(model: $0.model, cost: $0.cost, tokens: $0.totalTokens)
                }
                self.recentDaily = decoded.daily.suffix(7).map {
                    DailyUsage(date: $0.date, tokens: $0.totalTokens, cost: $0.cost)
                }
            }
        } catch {
            DispatchQueue.main.async { [weak self] in
                self?.lastError = "Parse error: \(error.localizedDescription)"
            }
        }
    }

    private func generateData() {
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            guard let self = self else { return }

            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = ["tokmeter", "--json"]

            let pipe = Pipe()
            process.standardOutput = pipe

            do {
                try process.run()
                // Use a timeout to avoid blocking indefinitely
                let timeoutDeadline = Date().addingTimeInterval(30)
                while process.isRunning && Date() < timeoutDeadline {
                    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
                }
                if process.isRunning {
                    process.terminate()
                    DispatchQueue.main.async {
                        self.lastError = "tokmeter timed out"
                    }
                    return
                }

                let outputData = pipe.fileHandleForReading.readDataToEndOfFile()
                let dirPath = (self.dataPath as NSString).deletingLastPathComponent
                let dirURL = URL(fileURLWithPath: dirPath)
                try FileManager.default.createDirectory(at: dirURL, withIntermediateDirectories: true)
                try outputData.write(to: URL(fileURLWithPath: self.dataPath))
                self.loadData()
            } catch {
                DispatchQueue.main.async {
                    self.lastError = "Generate error: \(error.localizedDescription)"
                }
            }
        }
    }
}

// MARK: - Menu Bar View

struct TokmeterBarView: View {
    @ObservedObject var loader: TokmeterLoader

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack {
                Text("Tokmeter")
                    .font(.headline)
                    .foregroundColor(.green)
                Spacer()
                if let error = loader.lastError {
                    Text(error)
                        .font(.caption2)
                        .foregroundColor(.red)
                        .lineLimit(1)
                }
                Button("Refresh") {
                    loader.loadData()
                }
                .buttonStyle(.borderless)
                .font(.caption)
            }

            Divider()

            // Stats: today + total
            HStack(spacing: 20) {
                VStack(alignment: .leading) {
                    Text("Today")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(String(format: "$%.2f", loader.todayCost))
                        .font(.title2)
                        .fontWeight(.bold)
                }
                VStack(alignment: .leading) {
                    Text("Total Tokens")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(formatNumber(loader.totalTokens))
                        .font(.title2)
                        .fontWeight(.bold)
                }
                VStack(alignment: .leading) {
                    Text("Total Cost")
                        .font(.caption)
                        .foregroundColor(.secondary)
                    Text(String(format: "$%.2f", loader.totalCost))
                        .font(.title2)
                        .fontWeight(.bold)
                }
            }

            // Top 3 models bar chart
            if !loader.topModels.isEmpty {
                Divider()
                Text("Top Models")
                    .font(.caption)
                    .foregroundColor(.secondary)

                Chart(loader.topModels) { model in
                    BarMark(
                        x: .value("Cost", model.cost),
                        y: .value("Model", model.model)
                    )
                    .foregroundStyle(Color.green.gradient)
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

            // 7-day sparkline
            if loader.recentDaily.count > 1 {
                Divider()
                Text("Last 7 Days")
                    .font(.caption)
                    .foregroundColor(.secondary)

                Chart(loader.recentDaily) { day in
                    LineMark(
                        x: .value("Date", day.date.suffix(5)),
                        y: .value("Cost", day.cost)
                    )
                    .foregroundStyle(Color.orange)
                    .interpolationMethod(.catmullRom)

                    AreaMark(
                        x: .value("Date", day.date.suffix(5)),
                        y: .value("Cost", day.cost)
                    )
                    .foregroundStyle(Color.orange.opacity(0.1))
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

            Divider()

            // Quick stats
            if let data = loader.data {
                HStack(spacing: 16) {
                    VStack(alignment: .leading) {
                        Text("Projects")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text("\(data.stats.projects)")
                            .font(.caption)
                            .fontWeight(.semibold)
                    }
                    VStack(alignment: .leading) {
                        Text("Active Days")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text("\(data.stats.activeDays)")
                            .font(.caption)
                            .fontWeight(.semibold)
                    }
                    VStack(alignment: .leading) {
                        Text("Streak")
                            .font(.caption2)
                            .foregroundColor(.secondary)
                        Text("\(data.stats.longestStreak)d")
                            .font(.caption)
                            .fontWeight(.semibold)
                    }
                }
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
        .frame(width: 340)
    }

    private func formatNumber(_ n: Int) -> String {
        if n >= 1_000_000 { return String(format: "%.1fM", Double(n) / 1_000_000) }
        if n >= 1_000 { return String(format: "%.1fK", Double(n) / 1_000) }
        return "\(n)"
    }
}

// MARK: - App

@main
struct TokmeterBarApp: App {
    @StateObject private var loader = TokmeterLoader()

    var body: some Scene {
        MenuBarExtra {
            TokmeterBarView(loader: loader)
        } label: {
            // Show today's cost in the menu bar
            Text(String(format: "⚡ $%.2f", loader.todayCost))
        }
        .menuBarExtraStyle(.window)
    }
}
