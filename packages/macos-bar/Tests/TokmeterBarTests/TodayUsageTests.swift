import XCTest
@testable import TokmeterBar

final class TodayUsageTests: XCTestCase {
    @MainActor
    func testIdleTodayDoesNotInheritLastActiveDay() throws {
        let loader = TokmeterLoader(startPolling: false)
        let old = try JSONDecoder().decode(DailyData.self, from: Data("""
        {"date":"2026-09-04","totalTokens":1100,"cost":1.25}
        """.utf8))
        let now = Calendar.current.date(from: DateComponents(year: 2026, month: 9, day: 6, hour: 12))!
        loader.todayTokens = 999
        loader.todayCost = 9
        loader.applyToday(from: [old], now: now)
        XCTAssertEqual(loader.todayTokens, 0)
        XCTAssertEqual(loader.todayCost, 0)
    }

    func testCostBreakdownPreservesUnavailableAndReportedZero() throws {
        let basis = try JSONDecoder().decode(CostBasis.self, from: Data("""
        {"estimatedCost":1.25,"reportedCost":0,"unclassifiedCost":0,"estimatedRecords":2,"reportedRecords":1,"unavailableRecords":3}
        """.utf8))
        XCTAssertEqual(basis.reportedRecords, 1)
        XCTAssertEqual(basis.unavailableRecords, 3)
        XCTAssertEqual(basis.estimatedCost, 1.25)
    }
}
