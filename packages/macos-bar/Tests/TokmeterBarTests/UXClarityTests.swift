import XCTest
@testable import TokmeterBar

/// The wording and number formats the UX review asked to be uniform: one
/// money format for rows, counts that agree with their noun, one date
/// format for tooltips, and the shared "empty synthetic" rule.
final class UXClarityTests: XCTestCase {
    func testRowMoneyKeepsCentsAndUsesThreeDecimalsOnlyBelowTenCents() {
        XCTAssertEqual(Fmt.money(144), "$144.00")
        XCTAssertEqual(Fmt.money(92.21), "$92.21")
        XCTAssertEqual(Fmt.money(0.1), "$0.10")
        XCTAssertEqual(Fmt.money(0.056), "$0.056")
        XCTAssertEqual(Fmt.money(0.0004), "<$0.001")
        XCTAssertEqual(Fmt.money(0), "$0.00")
        // Totals keep their K shorthand; rows don't.
        XCTAssertEqual(Fmt.cost(85_000), "$85K")
        XCTAssertEqual(Fmt.money(85_000), "$85,000.00")
        XCTAssertEqual(Fmt.money(1234.5), "$1,234.50")
        XCTAssertEqual(Fmt.money(250_000), "$250K")
    }

    func testCountsAgreeWithTheirNoun() {
        XCTAssertEqual(Fmt.count(0, "record"), "0 records")
        XCTAssertEqual(Fmt.count(1, "record"), "1 record")
        XCTAssertEqual(Fmt.count(3, "turn"), "3 turns")
        XCTAssertEqual(Fmt.count(2, "day", plural: "days"), "2 days")
    }

    func testPrettyDateIsOneFormat() {
        XCTAssertEqual(LocalDay.pretty("2026-09-07"), "Sep 07, 2026")
        XCTAssertEqual(LocalDay.pretty("2026-12-31"), "Dec 31, 2026")
        // Not a day key: unchanged, never a crash.
        XCTAssertEqual(LocalDay.pretty("today"), "today")
        XCTAssertEqual(LocalDay.pretty("2026-13-01"), "2026-13-01")
    }

    func testOnlyEmptySyntheticIsHidden() {
        XCTAssertTrue(Fmt.isEmptySynthetic(model: "<synthetic>", tokens: 0, cost: 0))
        // Cost with no tokens (tool-reported spend) stays, so rows add up.
        XCTAssertFalse(Fmt.isEmptySynthetic(model: "<synthetic>", tokens: 0, cost: 0.4))
        XCTAssertFalse(Fmt.isEmptySynthetic(model: "<synthetic>", tokens: 10, cost: 0))
        XCTAssertFalse(Fmt.isEmptySynthetic(model: "claude-opus-5-5", tokens: 0, cost: 0))
    }
}
