/**
 * @sriinnu/tokmeter-core — Kimi CLI session parser.
 *
 * Reads from ~/.kimi/sessions/{GROUP_ID}/{SESSION_UUID}/wire.jsonl
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class KimiParser implements SessionParser {
  readonly providerId: "kimi";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
