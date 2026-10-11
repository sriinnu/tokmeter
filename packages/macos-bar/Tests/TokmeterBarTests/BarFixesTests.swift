import SwiftUI
import XCTest

@testable import TokmeterBar

/// Regression guards for the bar audit fixes: unit boundaries, retired-theme
/// migration, selected-chip contrast and the auto-start backoff schedule.
final class BarFixesTests: XCTestCase {
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
