/**
 * @sriinnu/tokmeter-core — Qwen CLI session parser.
 *
 * Reads from ~/.qwen/projects/{PROJECT_PATH}/chats/{CHAT_ID}.jsonl
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class QwenParser implements SessionParser {
  readonly providerId: "qwen";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
