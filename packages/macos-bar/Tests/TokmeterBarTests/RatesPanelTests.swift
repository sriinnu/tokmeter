import AppKit
import SwiftUI
import XCTest
@testable import TokmeterBar

/// The rates wire shape decodes, and the cards render on every theme.
/// Fixture is real computeModelRates output (kosha rates, sample usage).
final class RatesPanelTests: XCTestCase {
    static let fixture = #"""
{"scope":"today","registryMtime":1791730448086.2903,"pricingUnavailable":false,"models":[{"model":"claude-opus-5-5","provider":"claude-code","source":{"tier":"kosha-exact"},"rates":{"input":{"perMillion":4,"derived":false},"output":{"perMillion":20,"derived":false},"cacheRead":{"perMillion":0.2,"derived":false},"cacheWrite":{"perMillion":5,"derived":false},"cacheWrite1h":{"perMillion":8,"derived":true,"basis":"2× input"},"reasoning":{"perMillion":20,"derived":true,"basis":"output rate"}},"usage":{"inputTokens":120000,"outputTokens":300000,"cacheReadTokens":40000000,"cacheWriteTokens":1500000,"reasoningTokens":0,"totalTokens":41920000,"cost":36.01},"effectivePerMillion":0.859017175572519},{"model":"fable-5-1","provider":"claude-code","source":{"tier":"kosha-fuzzy","matchedId":"claude-fable-5-1"},"rates":{"input":{"perMillion":10,"derived":false},"output":{"perMillion":50,"derived":false},"cacheRead":{"perMillion":0.25,"derived":false},"cacheWrite":{"perMillion":12.5,"derived":false},"cacheWrite1h":{"perMillion":12.5,"derived":true,"basis":"same as 5m write"},"reasoning":{"perMillion":50,"derived":true,"basis":"output rate"}},"usage":{"inputTokens":50000,"outputTokens":200000,"cacheReadTokens":20000000,"cacheWriteTokens":800000,"reasoningTokens":0,"totalTokens":21050000,"cost":44.69},"effectivePerMillion":2.123040380047506},{"model":"gpt-6-astra","provider":"codex","source":{"tier":"kosha-exact"},"rates":{"input":{"perMillion":10,"derived":false},"output":{"perMillion":50,"derived":false},"cacheRead":{"perMillion":1,"derived":false},"cacheWrite":{"perMillion":12.5,"derived":false},"cacheWrite1h":{"perMillion":12.5,"derived":true,"basis":"same as 5m write"},"reasoning":{"perMillion":50,"derived":true,"basis":"output rate"}},"usage":{"inputTokens":2000000,"outputTokens":500000,"cacheReadTokens":30000000,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":32500000,"cost":93.31},"effectivePerMillion":2.871076923076923},{"model":"claude-haiku-5-5","provider":"claude-code","source":{"tier":"kosha-exact"},"rates":{"input":{"perMillion":0.1,"derived":false},"output":{"perMillion":0.5,"derived":false},"cacheRead":{"perMillion":0.01,"derived":false},"cacheWrite":{"perMillion":0.125,"derived":false},"cacheWrite1h":{"perMillion":0.2,"derived":true,"basis":"2× input"},"reasoning":{"perMillion":0.5,"derived":true,"basis":"output rate"}},"usage":{"inputTokens":10000,"outputTokens":20000,"cacheReadTokens":500000,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":530000,"cost":0.03},"effectivePerMillion":0.056603773584905655},{"model":"<synthetic>","provider":"claude-code","source":{"tier":"unpriced"},"rates":{"input":{"perMillion":null,"derived":false},"output":{"perMillion":null,"derived":false},"cacheRead":{"perMillion":null,"derived":false},"cacheWrite":{"perMillion":null,"derived":false},"cacheWrite1h":{"perMillion":null,"derived":false},"reasoning":{"perMillion":null,"derived":false}},"usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":0,"cost":0},"effectivePerMillion":null}]}
"""#

    func testDecodesRateCard() throws {
        let r = try JSONDecoder().decode(RatesResponse.self, from: Data(Self.fixture.utf8))
        XCTAssertEqual(r.scope, "today")
        let opus = try XCTUnwrap(r.models.first { $0.model == "claude-opus-5-5" })
        XCTAssertEqual(opus.rates.input.perMillion, 4)
        XCTAssertEqual(opus.rates.cacheWrite1h.basis, "2× input")
        XCTAssertTrue(opus.rates.cacheWrite1h.derived)
        let fable = try XCTUnwrap(r.models.first { $0.model == "fable-5-1" })
        XCTAssertEqual(fable.source.tier, "kosha-fuzzy")
        XCTAssertEqual(fable.source.matchedId, "claude-fable-5-1")
        let synthetic = try XCTUnwrap(r.models.first { $0.model == "<synthetic>" })
        XCTAssertEqual(synthetic.source.tier, "unpriced")
        XCTAssertNil(synthetic.rates.input.perMillion)
        XCTAssertNil(synthetic.effectivePerMillion)
    }

    /// A model split across providers can arrive with fractional token
    /// counts. A strict Int decode used to throw and blank the whole panel.
    func testFractionalTokenCountsDecodeAndRound() throws {
        let fractional = Self.fixture
            .replacingOccurrences(of: "\"inputTokens\":120000,", with: "\"inputTokens\":120000.4,")
            .replacingOccurrences(of: "\"totalTokens\":41920000,", with: "\"totalTokens\":41920000.6,")
        XCTAssertNotEqual(fractional, Self.fixture)
        let r = try JSONDecoder().decode(RatesResponse.self, from: Data(fractional.utf8))
        let opus = try XCTUnwrap(r.models.first { $0.model == "claude-opus-5-5" })
        XCTAssertEqual(opus.usage.inputTokens, 120_000)
        XCTAssertEqual(opus.usage.totalTokens, 41_920_001)
    }

    func testMoneyFormat() {
        XCTAssertEqual(RateFormat.money(4), "$4.00")
        XCTAssertEqual(RateFormat.money(0.2), "$0.20")
        XCTAssertEqual(RateFormat.money(0.125), "$0.125")
        XCTAssertEqual(RateFormat.money(0.0028), "$0.0028")
        XCTAssertEqual(RateFormat.money(0.01), "$0.01")
        XCTAssertEqual(RateFormat.money(12.5), "$12.50")
        XCTAssertEqual(RateFormat.average(2.8711), "$2.87")
        XCTAssertEqual(RateFormat.average(0.0566), "$0.057")
    }

    @MainActor
    func testRenderCardsOnEveryTheme() throws {
        guard let directory = ProcessInfo.processInfo.environment["TOKMETER_UI_QA_DIR"] else {
            throw XCTSkip("Set TOKMETER_UI_QA_DIR to render the rates cards")
        }
        let r = try JSONDecoder().decode(RatesResponse.self, from: Data(Self.fixture.utf8))
        for theme in AppTheme.allCases {
            let view = VStack(alignment: .leading, spacing: 12) {
                ForEach(r.models) { RatesCardView(card: $0, theme: theme) }
            }
            .padding(14)
            .frame(width: 360)
            .background(LinearGradient(colors: theme.backgroundMode.gradientColors(),
                                       startPoint: .top, endPoint: .bottom))
            .environment(\.colorScheme, theme.backgroundMode.isLight ? .light : .dark)
            let renderer = ImageRenderer(content: view)
            renderer.scale = 2
            let image = try XCTUnwrap(renderer.nsImage)
            let bitmap = try XCTUnwrap(NSBitmapImageRep(data: XCTUnwrap(image.tiffRepresentation)))
            try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
                .write(to: URL(fileURLWithPath: directory).appendingPathComponent("rates-\(theme.rawValue).png"))
        }
    }
}
