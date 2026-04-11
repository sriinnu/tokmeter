/**
 * @sriinnu/tokmeter-core — Cursor IDE parser.
 *
 * Reads from ~/.config/tokscale/cursor-cache/ (CSV usage files).
 * Requires prior sync via Cursor API.
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class CursorParser implements SessionParser {
  readonly providerId: "cursor";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
