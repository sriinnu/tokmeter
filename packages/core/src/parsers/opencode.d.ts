/**
 * @sriinnu/tokmeter-core — OpenCode session parser.
 *
 * Reads from ~/.local/share/opencode/opencode.db (SQLite, v1.2+)
 * or ~/.local/share/opencode/storage/message/ (legacy JSON).
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class OpenCodeParser implements SessionParser {
  readonly providerId: "opencode";
  scan(homeDir: string): Promise<TokenRecord[]>;
  private loadSessionProjects;
}
