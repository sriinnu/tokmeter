import type { SessionParser, TokenRecord } from "../types.js";
export declare class ClaudeCodeParser implements SessionParser {
  readonly providerId: "claude-code";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
