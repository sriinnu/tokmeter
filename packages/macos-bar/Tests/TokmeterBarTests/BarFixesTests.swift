import SwiftUI
import XCTest

@testable import TokmeterBar

/// Regression guards for the bar audit fixes: unit boundaries, retired-theme
/// migration, selected-chip contrast and the auto-start backoff schedule.
final class BarFixesTests: XCTestCase {
    private func usage(_ model: String, _ provider: String, cost: Double) -> ModelUsage {
        ModelUsage(model: model, provider: provider, cost: cost, tokens: 1,
                   inputTokens: 1, outputTokens: 0, cacheReadTokens: 0,
                   cacheWriteTokens: 0, reasoningTokens: 0)
    }

    /// The shape of a real day: DeepSeek did most of its work cheaply and ranks
    /// below five costlier models from other providers.
    func testModelListKeepsCheapProviderBelowTheCut() {
        var models = (0..<9).map { usage("claude-\($0)", "claude-code", cost: Double(20 - $0)) }
        models.append(usage("deepseek-flash", "deepseek-harness", cost: 1))
        models.append(usage("deepseek-pro", "deepseek-harness", cost: 0.5))
        models.append(usage("gpt", "codex", cost: 0.25))

        let names = ModelsSection.rankedWithEveryProvider(models).map(\.model)

        XCTAssertEqual(names, ["claude-0", "claude-1", "claude-2", "claude-3", "claude-4",
                               "deepseek-flash", "gpt"])
    }

    func testModelListAddsNothingWhenTopFiveCoverEveryProvider() {
        let models = (0..<8).map { usage("m\($0)", $0 == 0 ? "codex" : "claude-code", cost: Double(9 - $0)) }
        XCTAssertEqual(ModelsSection.rankedWithEveryProvider(models).map(\.model),
                       ["m0", "m1", "m2", "m3", "m4"])
    }

    /// $0 rows have their own slots below, so they aren't promoted here.
    func testModelListLeavesZeroCostProviderToItsOwnSlots() {
        let models = (0..<5).map { usage("m\($0)", "codex", cost: Double(9 - $0)) }
            + [usage("free", "copilot", cost: 0)]
        XCTAssertEqual(ModelsSection.rankedWithEveryProvider(models).count, 5)
    }

    func testNumberPicksUnitAfterRounding() {
        XCTAssertEqual(Fmt.number(999), "999")
        XCTAssertEqual(Fmt.number(999_949), "999.9K")
        XCTAssertEqual(Fmt.number(999_950), "1.0M")
        XCTAssertEqual(Fmt.number(999_950_000), "1.0B")
    }

    func testCostPicksUnitAfterRounding() {
        XCTAssertEqual(Fmt.cost(99.994), "$99.99")
        XCTAssertEqual(Fmt.cost(99.996), "$100")
        XCTAssertEqual(Fmt.cost(999.4), "$999")
        XCTAssertEqual(Fmt.cost(999.6), "$1.0K")
        XCTAssertEqual(Fmt.cost(9_960), "$10K")
    }

    func testIntervalLabel() {
        XCTAssertEqual(Fmt.interval(30), "30s")
        XCTAssertEqual(Fmt.interval(300), "5m")
        XCTAssertEqual(Fmt.interval(90), "1m 30s")
    }

    func testRetiredThemesMigrateToAVisibleOne() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "BarFixesTests-\(UUID().uuidString)"))
        for (stored, expected) in [("synthwave", "terminal"), ("daylight", "paper"), ("noise", "nebula"),
                                   ("paper", "paper")] {
            defaults.set(stored, forKey: "appTheme")
            AppTheme.migrateStoredPreference(defaults)
            XCTAssertEqual(defaults.string(forKey: "appTheme"), expected, stored)
            XCTAssertTrue(AppTheme.allCases.contains(AppTheme(rawValue: expected)!))
        }
    }

    /// Ink on the selected fill must clear 4.5:1 against every stop, for
    /// every visible theme. White over phosphor green was ~1.3:1.
    func testSelectedChipInkContrastsWithEveryStop() {
        for theme in AppTheme.allCases {
            let ink = luminance(theme.onSelectedInk, over: .black)
            for stop in theme.selectedFill {
                let l = luminance(stop, over: .black)
                let ratio = (max(ink, l) + 0.05) / (min(ink, l) + 0.05)
                XCTAssertGreaterThanOrEqual(ratio, 4.5, "\(theme.displayName)")
            }
        }
    }

    private func luminance(_ color: Color, over backdrop: NSColor) -> Double {
        let ns = NSColor(color).usingColorSpace(.sRGB)!
        let a = Double(ns.alphaComponent)
        let base = backdrop.usingColorSpace(.sRGB)!
        func ch(_ c: CGFloat, _ b: CGFloat) -> Double {
            let v = Double(c) * a + Double(b) * (1 - a)
            return v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4)
        }
        return 0.2126 * ch(ns.redComponent, base.redComponent)
            + 0.7152 * ch(ns.greenComponent, base.greenComponent)
            + 0.0722 * ch(ns.blueComponent, base.blueComponent)
    }

    func testDevBuildPinsDaemonToBaseRelease() {
        XCTAssertEqual(NodeToolchain.daemonArguments(version: "1.14.1-dev"),
                       ["--yes", "@sriinnu/tokmeter-mcp@1.14.1", "daemon", "start"])
        XCTAssertEqual(NodeToolchain.daemonArguments(version: "1.14.1"),
                       ["--yes", "@sriinnu/tokmeter-mcp@1.14.1", "daemon", "start"])
    }
}
