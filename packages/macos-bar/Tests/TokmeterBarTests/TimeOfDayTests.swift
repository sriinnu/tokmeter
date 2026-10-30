import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

/// /api/statbar-signals `timeOfDay` decodes into the busiest-hours line, and
/// its absence or a bad shape hides the line without breaking the signals.
final class TimeOfDayTests: XCTestCase {
    /// Real core output: computeStatbarSignals over ten sealed days (spend at
    /// 02:30, 10:30, 16:30, 22:30), generated from packages/core/src.
    static let fixture = #"""
{"costBasisToday":{"estimatedCost":0,"reportedCost":0,"unclassifiedCost":0,"estimatedRecords":0,"reportedRecords":0,"unavailableRecords":0},"modelCostBasisToday":{},"burnRate":{"costPerHour":0,"tokensPerHour":0,"windowMinutes":60,"recordsInWindow":0},"cacheHitToday":{"rate":0,"canonicalRate":0,"readShare":0,"missRate":0,"freshInputShare":0,"cacheWriteShare":0,"cacheReadTokens":0,"cacheWriteTokens":0,"inputTokens":0,"freshInputTokens":0,"totalInputTokens":0},"contextPressure":{"status":"none","dragShare":0,"dragTokens":0,"currentInputTokens":0,"baselineInputTokens":0,"turnCount":0,"sessionAgeMinutes":0,"source":"none","provenance":"not_exposed","reason":"No request input telemetry was available."},"projectContextToday":[],"pace":{"multiple":0,"typicalCostByNow":1.5,"actualCostByNow":0,"daysOfHistory":7},"compactionToday":{"cost":0,"tokens":0,"share":0,"events":0},"subagentToday":{"cost":0,"records":0,"share":0},"reasoningToday":{"tokens":0,"outputTokens":0,"share":0,"records":0},"toolCallsToday":{"byTool":[],"totalCost":0,"callCount":0,"turnsWithTools":0},"billingWindow":null,"liveSession":null,"timeOfDay":{"windowDays":30,"minDays":7,"daysCounted":10,"daysSkipped":0,"status":"ok","totalCost":60,"blocks":[{"startHour":0,"endHour":3,"cost":5,"share":0.08333333333333333},{"startHour":3,"endHour":6,"cost":0,"share":0},{"startHour":6,"endHour":9,"cost":0,"share":0},{"startHour":9,"endHour":12,"cost":10,"share":0.16666666666666666},{"startHour":12,"endHour":15,"cost":0,"share":0},{"startHour":15,"endHour":18,"cost":30,"share":0.5},{"startHour":18,"endHour":21,"cost":0,"share":0},{"startHour":21,"endHour":24,"cost":15,"share":0.25}],"peak":{"startHour":15,"endHour":18,"cost":30,"share":0.5}}}
"""#

    private func decode(_ json: String) throws -> StatbarSignals {
        try JSONDecoder().decode(StatbarSignals.self, from: Data(json.utf8))
    }

    /// The fixture with its `timeOfDay` value swapped for `replacement`
    /// (or the key removed entirely when nil): an older daemon's payload.
    private func fixture(replacingTimeOfDayWith replacement: String?) -> String {
        let range = Self.fixture.range(of: #","timeOfDay":"#)!
        let head = String(Self.fixture[..<range.lowerBound])
        guard let replacement else { return head + "}" }
        return head + #","timeOfDay":"# + replacement + "}"
    }

    func testDecodesAndFormatsTheBusiestBlock() throws {
        let tod = try XCTUnwrap(try decode(Self.fixture).timeOfDay)
        XCTAssertEqual(tod.status, "ok")
        XCTAssertEqual(tod.blocks.count, 8)
        XCTAssertEqual(tod.daysCounted, 10)
        XCTAssertEqual(tod.busiestLine, "Busiest 15–18 · 50% of 30-day cost")
    }

    func testOlderDaemonHasNoLine() throws {
        let signals = try decode(fixture(replacingTimeOfDayWith: nil))
        XCTAssertNil(signals.timeOfDay)
        XCTAssertEqual(signals.pace.daysOfHistory, 7, "the rest still decodes")
    }

    func testNotEnoughDataHasNoLine() throws {
        let json = fixture(replacingTimeOfDayWith:
            #"{"windowDays":30,"minDays":7,"daysCounted":3,"daysSkipped":12,"status":"insufficient","totalCost":0,"blocks":[],"peak":null}"#)
        let tod = try XCTUnwrap(try decode(json).timeOfDay)
        XCTAssertEqual(tod.status, "insufficient")
        XCTAssertNil(tod.busiestLine)
    }

    /// A malformed profile must not take burn rate, pace and the rest with it.
    func testMalformedProfileDoesNotBreakSignals() throws {
        for bad in [#""garbage""#, #"{"status":"ok","blocks":"nope"}"#, "42"] {
            let signals = try decode(fixture(replacingTimeOfDayWith: bad))
            XCTAssertEqual(signals.burnRate.windowMinutes, 60, bad)
            XCTAssertNil(signals.timeOfDay?.busiestLine, bad)
        }
    }

    func testSharesThatDontAddUpHaveNoLine() {
        let blocks = (0..<8).map { TimeOfDayBlock(startHour: $0 * 3, endHour: $0 * 3 + 3, cost: 1, share: 0.2) }
        let p = TimeOfDayProfile(status: "ok", windowDays: 30, minDays: 7, daysCounted: 30, daysSkipped: 0,
                                 totalCost: 8, blocks: blocks, peak: blocks[0])
        XCTAssertNil(p.busiestLine)
    }

    /// Opt-in visual QA: the busiest-hours line and a showing rest nudge on
    /// every theme, as PNGs in TOKMETER_UI_QA_DIR.
    @MainActor
    func testRenderLinesOnEveryTheme() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_UI_QA_DIR to render the time-of-day and rest-nudge lines")
        }
        let tod = try decode(Self.fixture).timeOfDay
        let suite = "TimeOfDayTests.render.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/Berlin")!
        let monitor = RestNudgeMonitor(defaults: defaults, idleReader: { 5 }, calendar: { cal })
        for minute in 0...21 {
            monitor.tick(now: cal.date(from: DateComponents(year: 2026, month: 10, day: 30, hour: 1, minute: minute))!)
        }
        XCTAssertTrue(monitor.isShowing)
        for theme in AppTheme.allCases {
            let view = VStack(alignment: .leading, spacing: 12) {
                RestNudgeLine(monitor: monitor, theme: theme)
                BusiestHoursLine(profile: tod, theme: theme)
            }
            .padding(14)
            .frame(width: 400)
            .background(LinearGradient(colors: theme.backgroundMode.gradientColors(),
                                       startPoint: .top, endPoint: .bottom))
            .environment(\.colorScheme, theme.backgroundMode.isLight ? .light : .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.nsImage)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("time-of-day-\(theme.rawValue).png"))
        }
    }

    /// The owner's real 30-day split (2026-10-30, sealed relay): 15–18 carried
    /// 24.480%, which reads "24%" (one decimal shows 24.5, but that's 24.48).
    func testRealSplitRoundsToWholePercent() {
        let shares = [0.01770, 0.00382, 0.01295, 0.11275, 0.16253, 0.24480, 0.20627, 0.23918]
        let blocks = shares.enumerated().map {
            TimeOfDayBlock(startHour: $0.offset * 3, endHour: $0.offset * 3 + 3, cost: $0.element * 9737.3, share: $0.element)
        }
        let p = TimeOfDayProfile(status: "ok", windowDays: 30, minDays: 7, daysCounted: 30, daysSkipped: 0,
                                 totalCost: 9737.3, blocks: blocks, peak: blocks[5])
        XCTAssertEqual(p.busiestLine, "Busiest 15–18 · 24% of 30-day cost")
    }
}
