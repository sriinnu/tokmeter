// DaemonClient+Quota.swift — GET /api/quota.

import Foundation

extension DaemonClient {
    /// Each agent's plan windows with their pace; see packages/core/src/quota.ts.
    func fetchQuota() async throws -> QuotaResponse {
        try await get("/api/quota", as: QuotaResponse.self)
    }
}
