/**
 * @sriinnu/tokmeter-core — Mux session parser.
 *
 * Reads from ~/.mux/sessions/{WORKSPACE_ID}/session-usage.json
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class MuxParser implements SessionParser {
  readonly providerId: "mux";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
