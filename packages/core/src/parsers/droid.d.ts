/**
 * @sriinnu/tokmeter-core — Droid (Factory Droid) session parser.
 *
 * Reads from ~/.factory/sessions/
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class DroidParser implements SessionParser {
  readonly providerId: "droid";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
