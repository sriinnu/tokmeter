import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

/// /api/quota decodes and the section renders on every theme.
/// Fixture is real daemon output from 2026-10-21.
final class QuotaSectionTests: XCTestCase {
    static let fixture = #"""
{"windows":[{"agent":"claude-code","window":"5h","windowMinutes":300,"usedPct":4,"windowStart":1792595400,"resetsAt":1792613400,"sampledAt":1792601403146,"avgPctPerHour":2.398742259511865,"recentPctPerHour":2.6650404984366025,"hitsLimitAt":null,"verdict":"resets-first"},{"agent":"claude-code","window":"7d","windowMinutes":10080,"usedPct":44,"windowStart":1792202400,"resetsAt":1792807200,"sampledAt":1792601871449,"avgPctPerHour":0.39652395783621297,"recentPctPerHour":0.6066937532957374,"hitsLimitAt":null,"verdict":"resets-first"},{"agent":"codex","window":"7d","windowMinutes":10080,"usedPct":65,"windowStart":1792483922,"resetsAt":1793088722,"sampledAt":1792601902612,"plan":"pro","creditsBalance":5805.3307665,"avgPctPerHour":1.9833767263389233,"recentPctPerHour":1.1240002544611687,"hitsLimitAt":1792714002,"verdict":"hits-limit"}]}
"""#

    private var windows: [QuotaWindow] {
        get throws { try JSONDecoder().decode(QuotaResponse.self, from: Data(Self.fixture.utf8)).windows }
    }

    private let now = Date(timeIntervalSince1970: 1_792_601_903)

    func testDecodes() throws {
        let ws = try windows
        XCTAssertEqual(ws.map(\.id), ["claude-code:300", "claude-code:10080", "codex:10080"])
        let codex = try XCTUnwrap(ws.last)
        XCTAssertTrue(codex.isWarning)
        XCTAssertEqual(codex.plan, "pro")
        XCTAssertEqual(codex.hitsLimitAt, 1_792_714_002)
        XCTAssertNil(ws[0].hitsLimitAt)
        XCTAssertNil(ws[0].plan)
    }

    func testDetailSaysWhenItRunsOut() throws {
        let codex = try XCTUnwrap(try windows.last)
        let detail = QuotaFormat.detail(codex, now: now)
        XCTAssertTrue(detail.hasPrefix("100% by "), detail)
        XCTAssertTrue(detail.contains("at 1.1%/h"), detail)
        XCTAssertTrue(detail.contains(" · resets "), detail)
        XCTAssertFalse(detail.contains("ago"), "a fresh reading has no age")
        XCTAssertTrue(QuotaFormat.detail(try windows[0], now: now).hasPrefix("Resets "))
    }

    func testOldReadingSaysHowOld() throws {
        let codex = try XCTUnwrap(try windows.last)
        let later = now.addingTimeInterval(3 * 3600)
        XCTAssertTrue(QuotaFormat.detail(codex, now: later).hasSuffix(" · read 3h ago"))
    }

    func testPaceFormat() {
        XCTAssertEqual(QuotaFormat.pace(1.124), "1.1%/h")
        XCTAssertEqual(QuotaFormat.pace(12.4), "12%/h")
    }

    @MainActor
    func testRenderOnEveryTheme() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_UI_QA_DIR to render the quota section")
        }
        let ws = try windows
        for theme in AppTheme.allCases {
            let view = QuotaSection(windows: ws, theme: theme, now: now)
                .padding(14)
                .frame(width: 368)
                .background(LinearGradient(colors: theme.backgroundMode.gradientColors(),
                                           startPoint: .top, endPoint: .bottom))
                .environment(\.colorScheme, theme.backgroundMode.isLight ? .light : .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.nsImage)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("quota-\(theme.rawValue).png"))
        }
    }
}
