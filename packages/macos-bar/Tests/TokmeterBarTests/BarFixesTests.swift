import SwiftUI
import XCTest

@testable import TokmeterBar

/// Regression guards for the bar audit fixes: unit boundaries, retired-theme
/// migration, selected-chip contrast and the auto-start backoff schedule.
final class BarFixesTests: XCTestCase {
    private func usage(_ model: String, _ provider: String, cost: Double, tokens: Int = 1) -> ModelUsage {
        ModelUsage(model: model, provider: provider, cost: cost, tokens: tokens,
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

    /// The shape of a real day: a free OpenCode model below five paid ones.
    func testModelListGivesAFreeProviderARow() {
        let models = (0..<5).map { usage("m\($0)", "codex", cost: Double(9 - $0)) }
            + [usage("beam-free", "opencode", cost: 0, tokens: 966_252)]
        XCTAssertEqual(ModelsSection.rankedWithEveryProvider(models).last?.model, "beam-free")
    }

    func testFreeModelsRankByTokensWhateverOrderTheyArriveIn() {
        let quiet = usage("quiet-free", "opencode", cost: 0, tokens: 10)
        let busy = usage("busy-free", "opencode", cost: 0, tokens: 5_000)
        XCTAssertEqual(ModelsSection.rankedWithEveryProvider([quiet, busy], limit: 1).map(\.model), ["busy-free"])
    }

    func testZeroCostSlotsTakeTheBusiestAndSkipRankedRows() {
        let ranked = [usage("beam-free", "opencode", cost: 0, tokens: 900)]
        let models = ranked + [
            usage("a", "kimi", cost: 0, tokens: 1),
            usage("b", "kimi", cost: 0, tokens: 40),
            usage("c", "kimi", cost: 0, tokens: 30),
            usage("d", "kimi", cost: 0, tokens: 20),
            usage("paid", "codex", cost: 2, tokens: 99),
        ]
        XCTAssertEqual(ModelsSection.zeroCostSlots(models, excluding: ranked).map(\.model), ["b", "c", "d"])
    }

    func testRowMoneyStaysNarrowAtAnySize() {
        XCTAssertEqual(Fmt.money(9_999.99), "$9,999.99")
        XCTAssertEqual(Fmt.money(9_999.996), "$10,000")
        XCTAssertEqual(Fmt.money(25_748.05), "$25,748")
        XCTAssertEqual(Fmt.money(999_999.4), "$999,999")
        XCTAssertEqual(Fmt.money(999_999.6), "$1.00M")
        XCTAssertEqual(Fmt.money(1_250_000), "$1.25M")
        XCTAssertEqual(Fmt.money(999_994_000), "$999.99M")
        XCTAssertEqual(Fmt.money(1_250_000_000), "$1.25B")
        for amount in stride(from: 1.0, to: 1e11, by: 7_919_333.0) {
            XCTAssertLessThanOrEqual(Fmt.money(amount).count, 9, "\(amount)")
        }
    }

    func testTotalsKeepShorteningPastAMillion() {
        XCTAssertEqual(Fmt.cost(999_400), "$999K")
        XCTAssertEqual(Fmt.cost(999_600), "$1.0M")
        XCTAssertEqual(Fmt.cost(1_500_000), "$1.5M")
        XCTAssertEqual(Fmt.cost(48_000_000), "$48M")
        XCTAssertEqual(Fmt.cost(1_200_000_000), "$1.2B")
    }

    func testTooltipKeepsEveryCent() {
        XCTAssertEqual(Fmt.moneyExact(1_250_000.42), "$1,250,000.42")
    }

    func testFreeModelIdsAndRoutes() {
        XCTAssertTrue(Fmt.isFreeModel("beam-free@opencode"))
        XCTAssertTrue(Fmt.isFreeModel("poolside/laguna-m.1-20260312:free"))
        XCTAssertFalse(Fmt.isFreeModel("codex-auto-review"))
        XCTAssertFalse(Fmt.isFreeModel("freestyle-1"))
        XCTAssertEqual(Fmt.rowModelName("beam-free@opencode"), "beam-free")
        XCTAssertEqual(Fmt.servedBy("beam-free@opencode"), "opencode")
        // Other screens keep the full id, where no line beneath names the route.
        XCTAssertEqual(Fmt.shortModel("beam-free@opencode"), "beam-free@opencode")
    }

    /// Vertex dates its models with the same "@". Neither is a route.
    func testVertexDateIsNotARoute() {
        XCTAssertNil(Fmt.servedBy("claude-sonnet-4@20250514"))
        XCTAssertEqual(Fmt.rowModelName("claude-sonnet-4@20250514"), "sonnet-4@20250514")
        XCTAssertFalse(Fmt.isFreeModel("claude-sonnet-4@20250514"))
    }

    /// OpenCode reports a free model's $0, so the cost basis says it's priced.
    /// It must still read as free, not $0.00.
    func testReportedZeroOnAFreeModelStillHidesThePrice() throws {
        let reported = try JSONDecoder().decode(CostBasis.self, from: Data(
            #"{"reportedRecords":3,"estimatedRecords":0,"unavailableRecords":0,"reportedCost":0,"estimatedCost":0,"unclassifiedCost":0}"#.utf8))
        XCTAssertTrue(ModelsSection.hidesPrice(usage("beam-free@opencode", "opencode", cost: 0), basis: reported))
        XCTAssertFalse(ModelsSection.hidesPrice(usage("glm-4.7", "opencode", cost: 0), basis: reported))
        XCTAssertTrue(ModelsSection.hidesPrice(usage("codex-auto-review", "codex", cost: 0), basis: nil))
        XCTAssertFalse(ModelsSection.hidesPrice(usage("beam-free", "opencode", cost: 1), basis: nil))
    }

    @MainActor
    func testEveryMappedAgentHasADrawableLogo() {
        XCTAssertFalse(ProviderLogos.logoIDs.isEmpty)
        for provider in ProviderLogos.logoIDs.keys {
            let image = ProviderLogos.image(for: provider)
            XCTAssertNotNil(image, provider)
            XCTAssertGreaterThan(image?.size.width ?? 0, 0, provider)
            XCTAssertEqual(image?.isTemplate, true, provider)
        }
        XCTAssertNotNil(ProviderLogos.image(for: "antigravity"))
        XCTAssertNil(ProviderLogos.image(for: "ribhu"))
        XCTAssertEqual(ProviderLogos.displayName("ribhu"), "Ribhu")
        XCTAssertEqual(ProviderLogos.displayName("brand-new-agent"), "brand-new-agent")
    }

    /// The daemon's real shape, trimmed: extra fields must not break decoding,
    /// and an older daemon without these fields must still decode.
    func testProjectDecodesAgentsAndOlderDaemons() throws {
        let json = #"""
        {"project":"tokmeter","totalCost":12.4,"totalTokens":900,"activeDays":1,"lastUsed":1,"dailyBreakdown":[],
         "providers":[{"provider":"antigravity","totalTokens":300,"cost":3.4,"models":["opus"],"percentageOfTotal":1},
                      {"provider":"claude-code","totalTokens":600,"cost":9,"models":["opus"],"percentageOfTotal":1},
                      {"provider":"cursor","totalTokens":0,"cost":0,"models":[],"percentageOfTotal":0}],
         "models":[{"provider":"claude-code","model":"opus","totalTokens":600,"cost":9,"inputTokens":1},
                   {"provider":"antigravity","model":"opus","totalTokens":300,"cost":3.4,"inputTokens":1}]}
        """#
        let project = try JSONDecoder().decode(ProjectData.self, from: Data(json.utf8))
        XCTAssertEqual(project.agents.map(\.provider), ["claude-code", "antigravity"])
        XCTAssertEqual(project.agents.shares[0], 9 / 12.4, accuracy: 0.0001)
        XCTAssertEqual(project.agentModels.map(\.id), ["claude-code::opus", "antigravity::opus"])
        let older = try JSONDecoder().decode(ProjectData.self, from: Data(
            #"{"project":"old","totalCost":1,"totalTokens":1,"activeDays":1,"lastUsed":1}"#.utf8))
        XCTAssertTrue(older.agents.isEmpty)
    }

    func testRateCardExplainsItsPriceFlags() throws {
        func card(_ flags: String) throws -> ModelRateCard {
            let rate = #"{"perMillion":1,"derived":false}"#
            let json = """
            {"model":"m","provider":"p","source":{"tier":"manifest"}\(flags),"effectivePerMillion":null,
             "rates":{"input":\(rate),"output":\(rate),"cacheRead":\(rate),"cacheWrite":\(rate),"cacheWrite1h":\(rate),"reasoning":\(rate)},
             "usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"reasoningTokens":0,"totalTokens":0,"cost":0}}
            """
            return try JSONDecoder().decode(ModelRateCard.self, from: Data(json.utf8))
        }
        XCTAssertNil(try card("").priceWarning)
        XCTAssertEqual(try card(#","priceFlags":["disputed"]"#).priceWarning, "Price disputed: its sources list different rates.")
        XCTAssertTrue(try XCTUnwrap(card(#","priceFlags":["single-source","held"]"#).priceWarning).hasPrefix("New price held back"))
        XCTAssertEqual(try card(#","priceFlags":["single-source"]"#).priceWarning, "Big price move accepted on one source's word.")
    }

    func testAgentLegendShowsTokensWhenThereAreNoDollars() {
        XCTAssertEqual(ProjectAgent(provider: "codex", totalTokens: 9, cost: 3_727.86).legendAmount, "$3.7K")
        XCTAssertEqual(ProjectAgent(provider: "opencode", totalTokens: 1_400_000, cost: 0).legendAmount, "1.4M tokens")
    }

    func testAgentSharesFallBackToTokensWhenEverythingIsFree() {
        let free = [ProjectAgent(provider: "opencode", totalTokens: 300, cost: 0),
                    ProjectAgent(provider: "kimi", totalTokens: 100, cost: 0)]
        XCTAssertEqual(free.shares, [0.75, 0.25])
        XCTAssertEqual([ProjectAgent(provider: "x", totalTokens: 0, cost: 0)].shares, [0])
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
