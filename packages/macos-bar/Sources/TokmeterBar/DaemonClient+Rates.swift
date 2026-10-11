// DaemonClient+Rates.swift — GET /api/rates.

import Foundation

extension DaemonClient {
    /// Per-model rate card. `all: false` covers today's models; `true` every
    /// model with recorded usage.
    func fetchRates(all: Bool = false) async throws -> RatesResponse {
        try await get(all ? "/api/rates?scope=all" : "/api/rates", as: RatesResponse.self)
    }
}
