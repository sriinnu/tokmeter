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

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DAEMON_PORT = 9876;
export const DAEMON_HOST = "127.0.0.1";
export const DAEMON_URL = `ws://${DAEMON_HOST}:${DAEMON_PORT}`;

/**
 * Per-user daemon state dir. Previously these lived in /tmp which is
 * world-readable and shared across users — a local-multi-user box could TOCTOU
 * the token file and impersonate the daemon. Now scoped to `~/.tokmeter/daemon/`
 * with a 0700 directory so only the owning user can list/read state. The dir
 * is created lazily (mkdir-recursive, idempotent) the first time these paths
 * are referenced.
 *
 * Compatibility note: the macOS bar v1.4.0 still reads `/tmp/drishti-daemon.{pid,token}`.
 * server.ts therefore ALSO writes a shim copy at the old /tmp paths so already-installed
 * bars keep working until they ship a release that reads the new location.
 */
export const DAEMON_STATE_DIR = join(homedir(), ".tokmeter", "daemon");
try {
  mkdirSync(DAEMON_STATE_DIR, { recursive: true, mode: 0o700 });
} catch {
  /* dir may already exist with different perms; not fatal — we still write 0600 files */
}

export const DAEMON_PID_FILE = join(DAEMON_STATE_DIR, "daemon.pid");
export const DAEMON_TOKEN_FILE = join(DAEMON_STATE_DIR, "daemon.token");
export const DAEMON_STATE_FILE = join(DAEMON_STATE_DIR, "daemon-state.json");

/** Legacy /tmp paths kept as compat shims for older bar/statusline binaries. */
export const LEGACY_DAEMON_PID_FILE = "/tmp/drishti-daemon.pid";
export const LEGACY_DAEMON_TOKEN_FILE = "/tmp/drishti-daemon.token";
