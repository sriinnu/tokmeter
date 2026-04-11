/**
 * @sriinnu/tokmeter-core — Pi session parser.
 *
 * Reads from ~/.pi/agent/sessions/<encoded-cwd>/*.jsonl
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class PiParser implements SessionParser {
  readonly providerId: "pi";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
