import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

private struct DemoScene: Decodable {
    let caption: String
    let tokens: Int
    let signals: StatbarSignals
    let models: [ModelData]
    let projects: [ProjectData]
}

final class DemoRenderTests: XCTestCase {
    @MainActor
    func testRenderThemeReview() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_UI_QA_DIR for theme inspection")
        }
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { repository.deleteLastPathComponent() }
        let scenes = try JSONDecoder().decode([DemoScene].self, from: Data(contentsOf:
            repository.appendingPathComponent("docs/assets/demo/snapshots.json")))
        let scene = try XCTUnwrap(scenes.last)
        let root = URL(fileURLWithPath: directory)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = false
        loader.hasFreshData = true
        loader.todayTokens = scene.tokens
        loader.statbarSignals = scene.signals
        loader.todayModels = scene.models.map(TokmeterLoader.toUsage)
        loader.topModels = loader.todayModels
        loader.todayProjects = scene.projects
        for theme in AppTheme.allCases {
            for expanded in [false, true] {
                let view = VStack(alignment: .leading, spacing: 0) {
                    HeroHeader(loader: loader, theme: theme, breathToggle: false,
                               isVisible: false, showCachePanel: .constant(false))
                    UsageOverview(loader: loader, theme: theme, showUsageDetails: .constant(expanded))
                        .padding(16)
                }
                .frame(width: 400)
                .background(LinearGradient(colors: theme.backgroundMode.gradientColors(),
                                           startPoint: .topLeading, endPoint: .bottomTrailing))
                .environment(\.colorScheme, theme.backgroundMode.isLight ? .light : .dark)
                let renderer = ImageRenderer(content: view)
                renderer.scale = 2
                let image = try XCTUnwrap(renderer.nsImage)
                let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
                let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                try png.write(to: root.appendingPathComponent("\(theme.rawValue)-\(expanded ? "expanded" : "collapsed").png"))
            }
        }
    }

    /// Opt-in artifact rendering uses the production SwiftUI views and synthetic data.
    @MainActor
    func testRenderWalkthrough() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_DEMO_DIR"] else {
            throw XCTSkip("Set TOKMETER_DEMO_DIR to render the public walkthrough")
        }
        let root = URL(fileURLWithPath: directory)
        let scenes = try JSONDecoder().decode([DemoScene].self, from: Data(contentsOf: root.appendingPathComponent("snapshots.json")))
        for (index, scene) in scenes.enumerated() {
            let loader = TokmeterLoader(startPolling: false)
            loader.isWarming = false
            loader.hasFreshData = true
            loader.todayTokens = scene.tokens
            loader.statbarSignals = scene.signals
            loader.todayModels = scene.models.map(TokmeterLoader.toUsage)
            loader.topModels = loader.todayModels
            loader.todayProjects = scene.projects
            let view = VStack(alignment: .leading, spacing: 0) {
                Text(scene.caption)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .padding(16)
                HeroHeader(loader: loader, theme: .nebula, breathToggle: false, isVisible: false, showCachePanel: .constant(false))
                UsageOverview(loader: loader, theme: .nebula)
                    .padding(16)
                Spacer(minLength: 8)
                Text("DEMO DATA · API estimates are not your subscription bill")
                    .font(.system(size: 9))
                    .foregroundStyle(.secondary)
                    .padding(16)
            }
            .frame(width: 400, height: 560, alignment: .topLeading)
            .background(Color(red: 0.035, green: 0.04, blue: 0.07))
            .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.nsImage)
            let tiff = try XCTUnwrap(image.tiffRepresentation)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: tiff))
            let png = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
            try png.write(to: root.appendingPathComponent(String(format: "scene-%02d.png", index)))
        }
    }
}
