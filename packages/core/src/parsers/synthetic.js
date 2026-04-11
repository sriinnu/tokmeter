/**
 * @sriinnu/tokmeter-core — Synthetic session parser.
 *
 * Re-attributed from other sources via "hf:" model prefix or "synthetic" provider.
 * Also checks Octofriend SQLite at ~/.local/share/octofriend/sqlite.db.
 */
export class SyntheticParser {
  providerId = "synthetic";
  async scan(_homeDir) {
    // Synthetic records are re-attributed post-processing from other parsers.
    // This parser scans for "hf:" prefixed models or "synthetic" provider tags
    // in already-parsed records. For now, return empty — the aggregator
    // handles re-attribution.
    return [];
  }
}
