/**
 * @sriinnu/tokmeter-core — Kilo (VS Code extension) session parser.
 *
 * Same shape as Roo Code — reads ui_messages.json from VS Code globalStorage.
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class KiloParser implements SessionParser {
  readonly providerId: "kilo";
  private readonly paths;
  scan(homeDir: string): Promise<TokenRecord[]>;
}
