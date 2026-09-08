import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

final class ThemeContrastTests: XCTestCase {
    @MainActor
    func testStatusInkContrastAndThemeAppearance() throws {
        for theme in [AppTheme.glass, .paper, .terminal, .nebula] {
            for color in [theme.statusWarning, theme.statusSuccess, theme.statusDanger] {
                let lightHost = try renderedRGB(color, scheme: .light)
                let darkHost = try renderedRGB(color, scheme: .dark)
                for (a, b) in zip(lightHost, darkHost) { XCTAssertEqual(a, b, accuracy: 0.01) }
                if theme.backgroundMode.isLight {
                    for gray in [0.65, 0.8, 0.95] {
                        XCTAssertGreaterThanOrEqual(contrast(darkHost, [gray, gray, gray]), 4.5)
                    }
                } else {
                    XCTAssertGreaterThan(contrast(lightHost, [0.06, 0.07, 0.10]), 4.5)
                }
            }
        }
        try renderContrastWidgets()
    }

    @MainActor
    private func renderContrastWidgets() throws {
        let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"]
        var repository = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { repository.deleteLastPathComponent() }
        let scenes = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf:
            repository.appendingPathComponent("docs/assets/demo/snapshots.json"))) as? [[String: Any]])
        var signals = try XCTUnwrap(scenes.last?["signals"] as? [String: Any])
        var burn = try XCTUnwrap(signals["burnRate"] as? [String: Any])
        burn["costPerHour"] = 145
        signals["burnRate"] = burn
        var pace = try XCTUnwrap(signals["pace"] as? [String: Any])
        pace["multiple"] = 15
        pace["daysOfHistory"] = 7
        signals["pace"] = pace
        let loader = TokmeterLoader(startPolling: false)
        loader.isWarming = false
        loader.totalTokens = 3_159_000
        loader.totalCost = 2701
        loader.recentDaily = [DailyUsage(date: "2020-01-01", tokens: 1_000_000, cost: 1000),
                              DailyUsage(date: "2020-01-02", tokens: 3_159_000, cost: 2701)]
        loader.statbarSignals = try JSONDecoder().decode(StatbarSignals.self,
            from: JSONSerialization.data(withJSONObject: signals))
        for theme in [AppTheme.glass, .paper, .terminal] {
            let host = NSHostingView(rootView: VStack(spacing: 14) {
                SignalsRibbon(loader: loader, theme: theme)
                StatsGrid(loader: loader, theme: theme)
            }
            .padding(16)
            .frame(width: 400)
            .fixedSize(horizontal: false, vertical: true)
            .background(theme == .glass ? Color(red: 0.70, green: 0.72, blue: 0.76) : theme.backgroundMode.surfaceColor)
            .environment(\.colorScheme, .dark))
            let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 400, height: 220),
                                  styleMask: [.borderless], backing: .buffered, defer: false)
            window.appearance = NSAppearance(named: .darkAqua)
            window.contentView = host
            for _ in 0..<20 {
                host.layoutSubtreeIfNeeded()
                window.setContentSize(host.fittingSize)
                RunLoop.main.run(until: Date().addingTimeInterval(0.03))
            }
            let bitmap = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            // Exercise production widgets inside a Dark Aqua native host even
            // when the selected theme is light. Both pace and delta text must
            // contain the selected theme's opaque ink in the captured pixels.
            for color in [theme.statusWarning, theme.statusSuccess] {
                let expected = try renderedRGB(color, scheme: .dark)
                var matches = 0
                for y in 0..<bitmap.pixelsHigh {
                    for x in 0..<bitmap.pixelsWide {
                        guard let pixel = bitmap.colorAt(x: x, y: y)?.usingColorSpace(.sRGB) else { continue }
                        let actual = [pixel.redComponent, pixel.greenComponent, pixel.blueComponent]
                        if zip(actual, expected).allSatisfy({ abs($0 - $1) < 0.025 }) { matches += 1 }
                    }
                }
                XCTAssertGreaterThan(matches, 5, "Missing selected-theme status ink in \(theme) widgets")
            }
            if let directory {
                try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                    .write(to: URL(fileURLWithPath: directory).appendingPathComponent("contrast-\(theme.rawValue).png"))
            }
            window.contentView = nil
        }
    }

    @MainActor
    private func renderedRGB(_ color: Color, scheme: ColorScheme) throws -> [Double] {
        let renderer = ImageRenderer(content: color.frame(width: 10, height: 10)
            .environment(\.colorScheme, scheme))
        let image = try XCTUnwrap(renderer.nsImage)
        let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
        let pixel = try XCTUnwrap(bitmap.colorAt(x: 5, y: 5)?.usingColorSpace(.sRGB))
        return [pixel.redComponent, pixel.greenComponent, pixel.blueComponent]
    }

    private func luminance(_ rgb: [Double]) -> Double {
        let linear = rgb.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        return zip(linear, [0.2126, 0.7152, 0.0722]).map(*).reduce(0, +)
    }

    private func contrast(_ a: [Double], _ b: [Double]) -> Double {
        let x = luminance(a), y = luminance(b)
        return (max(x, y) + 0.05) / (min(x, y) + 0.05)
    }
}
