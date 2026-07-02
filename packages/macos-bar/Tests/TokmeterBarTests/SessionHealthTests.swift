import XCTest

@testable import TokmeterBar

/// Covers the menubar health band — the pure logic that mirrors
/// packages/core/src/session-health.ts. Keeps the 50/75/90 thresholds and the
/// worst-session-wins / absent-reading semantics honest across both languages.
final class SessionHealthTests: XCTestCase {
    func testBandForPctThresholds() {
        XCTAssertEqual(HealthBand.forPct(0), .ok)
        XCTAssertEqual(HealthBand.forPct(49.9), .ok)
        XCTAssertEqual(HealthBand.forPct(50), .warn)
        XCTAssertEqual(HealthBand.forPct(74.9), .warn)
        XCTAssertEqual(HealthBand.forPct(75), .high)
        XCTAssertEqual(HealthBand.forPct(89.9), .high)
        XCTAssertEqual(HealthBand.forPct(90), .critical)
        XCTAssertEqual(HealthBand.forPct(100), .critical)
        XCTAssertEqual(HealthBand.forPct(150), .critical) // over 100% stays critical
    }

    func testUnknownReadingsNeverAlarm() {
        XCTAssertEqual(HealthBand.forPct(.nan), .ok)
        XCTAssertEqual(HealthBand.forPct(.infinity), .ok) // non-finite → ok, not critical
        XCTAssertEqual(HealthBand.forPct(-5), .ok)
    }

    func testCustomThresholds() {
        XCTAssertEqual(HealthBand.forPct(25, warn: 20, high: 40, critical: 60), .warn)
        XCTAssertEqual(HealthBand.forPct(65, warn: 20, high: 40, critical: 60), .critical)
    }

    func testWorstWinsAcrossSessions() {
        XCTAssertEqual(HealthBand.worst([.ok, .warn, .critical, .high]), .critical)
        XCTAssertEqual(HealthBand.worst([.ok, .warn]), .warn)
    }

    func testWorstIgnoresAbsentReadings() {
        // A provider that can't produce a signal contributes nil, not a band.
        XCTAssertEqual(HealthBand.worst([nil, .warn, nil, .high]), .high)
    }

    func testWorstIsNilWhenNothingReports() {
        XCTAssertNil(HealthBand.worst([nil, nil]))
        XCTAssertNil(HealthBand.worst([]))
    }

    func testBandOrderingIsBySeverity() {
        XCTAssertLessThan(HealthBand.ok, HealthBand.warn)
        XCTAssertLessThan(HealthBand.warn, HealthBand.high)
        XCTAssertLessThan(HealthBand.high, HealthBand.critical)
    }
}
