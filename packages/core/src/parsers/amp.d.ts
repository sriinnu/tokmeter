/**
 * @sriinnu/tokmeter-core — Amp (AmpCode) session parser.
 *
 * Reads from ~/.local/share/amp/threads/
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class AmpParser implements SessionParser {
  readonly providerId: "amp";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
