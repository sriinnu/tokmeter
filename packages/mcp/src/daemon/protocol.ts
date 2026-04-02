/**
 * Drishti Daemon — Protocol types for cross-provider aggregation
 */

// ─── Message Types ─────────────────────────────────────────────────────

export interface SessionInfo {
  provider: string; // "claude-code" | "cursor" | "codex" | "opencode" | ...
  sessionId: string; // Unique session identifier
  model: string; // Model being used
  project?: string; // Project name
  cwd?: string; // Working directory
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

export interface SessionUpdate {
  type: "update";
  session: SessionInfo;
  cost: number;
  tokens: TokenUsage;
  durationMs?: number;
}

export interface SessionRegister {
  type: "register";
  session: SessionInfo;
}

export interface SessionUnregister {
  type: "unregister";
  sessionId: string;
  provider: string;
}

export interface BroadcastMessage {
  type: "broadcast";
  yourSession: {
    cost: number;
    tokens: TokenUsage;
  };
  aggregated: AggregatedStats;
}

export interface AggregatedStats {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  sessions: number;
  providers: string[];
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
}

export interface ModelBreakdown {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderBreakdown {
  provider: string;
  cost: number;
  sessions: number;
}

export type ClientMessage = SessionRegister | SessionUpdate | SessionUnregister;
export type ServerMessage =
  | BroadcastMessage
  | { type: "ack"; success: boolean }
  | { type: "error"; message: string };

// ─── Daemon Config ─────────────────────────────────────────────────────

export const DAEMON_PORT = 9876;
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}`;
export const DAEMON_PID_FILE = "/tmp/drishti-daemon.pid";
export const DAEMON_STATE_FILE = "/tmp/drishti-daemon-state.json";
