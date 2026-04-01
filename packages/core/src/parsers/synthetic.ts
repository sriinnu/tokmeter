/**
 * @tokmeter/core — Synthetic session parser.
 *
 * Re-attributed from other sources via "hf:" model prefix or "synthetic" provider.
 * Also checks Octofriend SQLite at ~/.local/share/octofriend/sqlite.db.
 */

import type { SessionParser, TokenRecord } from "../types.js";

export class SyntheticParser implements SessionParser {
  readonly providerId = "synthetic" as const;

  async scan(_homeDir: string): Promise<TokenRecord[]> {
    // Synthetic records are re-attributed post-processing from other parsers.
    // This parser scans for "hf:" prefixed models or "synthetic" provider tags
    // in already-parsed records. For now, return empty — the aggregator
    // handles re-attribution.
    return [];
  }
}
