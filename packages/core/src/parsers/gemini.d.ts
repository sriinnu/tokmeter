/**
 * @sriinnu/tokmeter-core — Gemini CLI session parser.
 *
 * Reads from ~/.gemini/tmp/{id}/chats/{file}.json
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class GeminiParser implements SessionParser {
  readonly providerId: "gemini";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
