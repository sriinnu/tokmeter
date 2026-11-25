import Foundation
import XCTest
@testable import TokmeterBar

final class DaemonContractTests: XCTestCase {
    private func loadContractSections() throws -> [String: Any] {
        // packages/macos-bar/Tests/TokmeterBarTests/DaemonContractTests.swift -> repo root
        let contractURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent() // TokmeterBarTests
            .deletingLastPathComponent() // Tests
            .deletingLastPathComponent() // macos-bar
            .deletingLastPathComponent() // packages
            .deletingLastPathComponent() // repo root
            .appendingPathComponent("contracts")
            .appendingPathComponent("daemon-api-contract.json")

        let rawData = try Data(contentsOf: contractURL)
        let parsed = try JSONSerialization.jsonObject(with: rawData)
        guard let sections = parsed as? [String: Any] else {
            XCTFail("Expected top-level dictionary in daemon-api-contract.json")
            return [:]
        }
        return sections
    }

    private func decodeSection<T: Decodable>(
        _ type: T.Type,
        from sections: [String: Any],
        key: String
    ) throws -> T {
        guard let section = sections[key] else {
            throw NSError(
                domain: "DaemonContractTests",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Missing section '\(key)' in contract JSON"]
            )
        }
        let sectionData = try JSONSerialization.data(withJSONObject: section)
        return try JSONDecoder().decode(T.self, from: sectionData)
    }

    func testAllSwiftWireModelsDecodeCanonicalDaemonContract() throws {
        let sections = try loadContractSections()

        let ready = try decodeSection(ReadyResponse.self, from: sections, key: "ready")
        XCTAssertTrue(ready.ready)
        XCTAssertEqual(ready.apiVersion, 1)

        let quick = try decodeSection(QuickResponse.self, from: sections, key: "quick")
        XCTAssertTrue(quick.ready)
        XCTAssertGreaterThan(quick.stats.totalCost, 0)
        XCTAssertEqual(quick.liveContextFillPct, 42.5)
        XCTAssertEqual(quick.blockElapsedPct, 60.0)

        let daily = try decodeSection([DailyData].self, from: sections, key: "daily")
        XCTAssertEqual(daily.count, 1)
        XCTAssertEqual(daily.first?.inputTokens, 3000)

        let models = try decodeSection([ModelData].self, from: sections, key: "models")
        XCTAssertEqual(models.first?.provider, "claude-code")

        let sessions = try decodeSection([ProjectData].self, from: sections, key: "sessions")
        XCTAssertEqual(sessions.first?.project, "alpha-app")
        XCTAssertEqual(sessions.first?.agents.first?.provider, "claude-code")
        XCTAssertEqual(sessions.first?.agentModels.first?.model, "claude-sonnet-4-5")

        let projectDetail = try decodeSection(ProjectDetailData.self, from: sections, key: "projectDetail")
        XCTAssertEqual(projectDetail.project, "alpha-app")
        XCTAssertFalse(projectDetail.models.isEmpty)

        let pricing = try decodeSection(PricingStatus.self, from: sections, key: "pricingStatus")
        XCTAssertGreaterThan(pricing.registryMtime, 0)

        let cron = try decodeSection(CronStatus.self, from: sections, key: "cronStatus")
        XCTAssertEqual(cron.lastRunOk, true)

        let health = try decodeSection(HealthStatus.self, from: sections, key: "health")
        XCTAssertEqual(health.unpricedRecords, 0)

        let anomalies = try decodeSection(AnomaliesResponse.self, from: sections, key: "anomalies")
        XCTAssertEqual(anomalies.total, 1)
        XCTAssertEqual(anomalies.anomalies.first?.field, "input")

        let signals = try decodeSection(StatbarSignals.self, from: sections, key: "statbarSignals")
        XCTAssertNotNil(signals.costBasisToday)
        XCTAssertNotNil(signals.contextPressure)
        XCTAssertNotNil(signals.billingWindow)
        XCTAssertNotNil(signals.liveSession)
        XCTAssertNotNil(signals.timeOfDay?.busiestLine)

        let crossTool = try decodeSection(CrossToolComparison.self, from: sections, key: "crossTool")
        XCTAssertEqual(crossTool.projections.first?.model, "gpt-5")

        let quota = try decodeSection(QuotaResponse.self, from: sections, key: "quota")
        XCTAssertEqual(quota.windows.first?.verdict, "resets-first")

        let rates = try decodeSection(RatesResponse.self, from: sections, key: "rates")
        XCTAssertEqual(rates.scope, "all")
        XCTAssertEqual(rates.models.first?.source.tier, "seeded")
        XCTAssertEqual(rates.models.first?.rates.cacheWrite1h.derived, true)

        let antigravity = try decodeSection(AntigravityLiveResponse.self, from: sections, key: "antigravityLive")
        XCTAssertEqual(antigravity.latestSnapshot?.availablePromptCredits, 450)
        XCTAssertEqual(antigravity.creditsUsedToday?.promptCreditsUsed, 50)

        let snapshot = try decodeSection(BarSnapshotResponse.self, from: sections, key: "barSnapshot")
        XCTAssertFalse(snapshot.daily?.isEmpty ?? true)
        XCTAssertEqual(snapshot.partialErrors, [])
        XCTAssertNotNil(snapshot.statbarSignals)
    }
}
