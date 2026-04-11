/**
 * @sriinnu/tokmeter-core — Codex CLI session parser.
 *
 * Reads from $CODEX_HOME/sessions/ or ~/.codex/sessions/
 * Sessions are stored in YYYY/MM/DD/ subdirectories as .jsonl files.
 *
 * Format: RolloutItem events (session_meta, turn_context, event_msg, etc.)
 * Token data comes from event_msg with type "token_count".
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class CodexParser implements SessionParser {
  readonly providerId: "codex";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
