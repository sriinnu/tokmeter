/**
 * @sriinnu/tokmeter-core — Roo Code session parser.
 *
 * Reads from VS Code globalStorage task directories.
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class RooCodeParser implements SessionParser {
  readonly providerId: "roo-code";
  private readonly paths;
  scan(homeDir: string): Promise<TokenRecord[]>;
}
