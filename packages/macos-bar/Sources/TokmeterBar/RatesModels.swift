// RatesModels.swift — wire types for GET /api/rates (the per-model rate card).
//
// Mirrors packages/core/src/model-rates.ts. A rate is $ per million tokens,
// exactly as billing uses it; `nil` means billing doesn't charge that bucket
// (or the model is unpriced) — never a guessed number.

import Foundation

struct RatesResponse: Decodable {
    let scope: String
    /// mtime (ms) of ~/.kosha/registry.json; 0 when absent.
    let registryMtime: Double
    let pricingUnavailable: Bool
    let models: [ModelRateCard]
}

struct ModelRateCard: Decodable, Identifiable {
    let model: String
    let provider: String
    let source: PricingSource
    let rates: Rates
    let usage: Usage
    /// cost ÷ tokens × 1M actually paid; nil with no tokens.
    let effectivePerMillion: Double?

    var id: String { "\(provider)/\(model)" }

    struct Rates: Decodable {
        let input: Rate
        let output: Rate
        let cacheRead: Rate
        /// 5-minute-TTL cache write.
        let cacheWrite: Rate
        /// 1-hour-TTL cache write.
        let cacheWrite1h: Rate
        let reasoning: Rate
    }

    struct Usage: Decodable {
        let inputTokens: Int
        let outputTokens: Int
        let cacheReadTokens: Int
        let cacheWriteTokens: Int
        let reasoningTokens: Int
        let totalTokens: Int
        let cost: Double

        private enum CodingKeys: String, CodingKey {
            case inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens
            case reasoningTokens, totalTokens, cost
        }

        /// Token counts are whole numbers, but a model whose usage was split
        /// across providers can arrive as 12345.5. A strict Int decode threw
        /// and blanked the whole "All" view, so accept either and round.
        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            func count(_ key: CodingKeys) throws -> Int {
                if let whole = try? c.decode(Int.self, forKey: key) { return whole }
                let value = try c.decode(Double.self, forKey: key)
                return value.isFinite ? Int(value.rounded()) : 0
            }
            inputTokens = try count(.inputTokens)
            outputTokens = try count(.outputTokens)
            cacheReadTokens = try count(.cacheReadTokens)
            cacheWriteTokens = try count(.cacheWriteTokens)
            reasoningTokens = try count(.reasoningTokens)
            totalTokens = try count(.totalTokens)
            cost = try c.decode(Double.self, forKey: .cost)
        }

        init(inputTokens: Int, outputTokens: Int, cacheReadTokens: Int, cacheWriteTokens: Int,
             reasoningTokens: Int, totalTokens: Int, cost: Double) {
            self.inputTokens = inputTokens
            self.outputTokens = outputTokens
            self.cacheReadTokens = cacheReadTokens
            self.cacheWriteTokens = cacheWriteTokens
            self.reasoningTokens = reasoningTokens
            self.totalTokens = totalTokens
            self.cost = cost
        }
    }
}

struct Rate: Decodable {
    let perMillion: Double?
    /// The registry lacks this field; billing applies `basis` instead.
    let derived: Bool
    let basis: String?
}

struct PricingSource: Decodable {
    /// override · kosha-exact · kosha-fuzzy · kosha-provider · manifest · seeded · unpriced
    let tier: String
    /// Registry id the price came from, when it differs from the model id.
    let matchedId: String?

    /// "ollama-cloud" from a kosha-provider matchedId like "ollama-cloud:deepseek-v4.1-flash".
    private var servingProvider: String? {
        matchedId?.split(separator: ":", maxSplits: 1).first.map(String.init)
    }

    /// Short human label for the source tag.
    var label: String {
        switch tier {
        case "override": return "your override"
        case "kosha-exact": return "price catalog"
        case "kosha-fuzzy": return "catalog ≈ \(matchedId ?? "match")"
        case "kosha-provider": return "\(servingProvider ?? "provider")'s rate"
        case "manifest": return matchedId.map { "saved catalog ≈ \($0)" } ?? "saved catalog"
        case "seeded": return "built-in rate"
        default: return "unpriced"
        }
    }

    var help: String {
        switch tier {
        case "override": return "From ~/.tokmeter/pricing-overrides.json — your own rate wins over the kosha catalog."
        case "kosha-exact": return "Price source: kosha, the model price catalog. It has this exact model id."
        case "kosha-fuzzy":
            return "Price source: kosha, the model price catalog. No exact id there; priced as the closest match, \(matchedId ?? "unknown"). Check it's the same model."
        case "kosha-provider":
            return "Price source: kosha, the model price catalog. Priced at the rate of the provider that served it, \(matchedId ?? "unknown"); the same model costs differently on other routes."
        case "manifest":
            return "Price source: kosha. Read from the saved catalog (~/.kosha/registry.json)\(matchedId.map { " as \($0)" } ?? ""); the live catalog didn't have it."
        default: return "No price anywhere: usage priced by API rates counts as $0. Add it to pricing-overrides.json to price it."
        }
    }
}
