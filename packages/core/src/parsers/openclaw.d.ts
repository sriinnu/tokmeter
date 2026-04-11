/**
 * @sriinnu/tokmeter-core — OpenClaw session parser.
 *
 * Reads from ~/.openclaw/agents/{id}/sessions/sessions.json
 * Also scans legacy paths: ~/.clawdbot/, ~/.moltbot/, ~/.moldbot/
 */
import type { SessionParser, TokenRecord } from "../types.js";
export declare class OpenClawParser implements SessionParser {
  readonly providerId: "openclaw";
  scan(homeDir: string): Promise<TokenRecord[]>;
}
