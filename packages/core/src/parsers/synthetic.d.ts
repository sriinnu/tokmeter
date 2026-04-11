/**
 * @sriinnu/tokmeter-core — Synthetic session parser.
 *
 * Re-attributed from other sources via "hf:" model prefix or "synthetic" provider.
 * Also checks Octofriend SQLite at ~/.local/share/octofriend/sqlite.db.
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class SyntheticParser implements SessionParser {
  readonly providerId: "synthetic";
  scan(_homeDir: string): Promise<TokenRecord[]>;
}
