/**
 * Drishti Daemon — Client for statusline integration
 *
 * Provides a simple sync interface for statusline hooks to:
 * 1. Report session data to the daemon
 * 2. Receive aggregated stats from all providers
 */

import WebSocket from "ws";
import type { AggregatedStats, BroadcastMessage, SessionInfo, TokenUsage } from "./protocol.js";
import { DAEMON_URL } from "./protocol.js";

// ─── Response Types ─────────────────────────────────────────────────────

export interface DaemonResponse {
  connected: boolean;
  yourSession?: {
    cost: number;
    tokens: TokenUsage;
  };
  aggregated?: AggregatedStats;
}

// ─── Sync Client (for statusline hooks) ─────────────────────────────────

/**
 * Connect to daemon, send update, receive aggregated stats.
 * Uses a timeout to avoid blocking the statusline.
 */
export function syncUpdate(
  session: SessionInfo,
  cost: number,
  tokens: TokenUsage,
  durationMs?: number,
  timeoutMs = 200
): DaemonResponse {
  let result: DaemonResponse = { connected: false };

  try {
    const ws = new WebSocket(DAEMON_URL);

    // Synchronous-like behavior with timeout
    const startTime = Date.now();

    ws.on("open", () => {
      ws.send(
        JSON.stringify({
          type: "update",
          session,
          cost,
          tokens,
          durationMs,
        })
      );
    });

    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as BroadcastMessage;
        if (msg.type === "broadcast") {
          result = {
            connected: true,
            yourSession: msg.yourSession,
            aggregated: msg.aggregated,
          };
          ws.close();
        }
      } catch {}
    });

    // Busy wait with timeout (statusline must be fast)
    while (!result.connected && Date.now() - startTime < timeoutMs) {
      // Allow event loop to process
    }
  } catch {
    // Daemon not running
  }

  return result;
}

/**
 * Quick check if daemon is running
 */
export function isDaemonReachable(): boolean {
  try {
    const _ws = new WebSocket(DAEMON_URL);
    return true;
  } catch {
    return false;
  }
}

// ─── Async Client (for MCP server) ──────────────────────────────────────

export class DaemonClient {
  private ws: WebSocket | null = null;
  private session: SessionInfo | null = null;

  async connect(session: SessionInfo): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(DAEMON_URL);
        this.session = session;

        this.ws.on("open", () => {
          this.ws?.send(
            JSON.stringify({
              type: "register",
              session,
            })
          );
          resolve(true);
        });

        this.ws.on("error", () => resolve(false));
      } catch {
        resolve(false);
      }
    });
  }

  async update(
    cost: number,
    tokens: TokenUsage,
    durationMs?: number
  ): Promise<BroadcastMessage | null> {
    return new Promise((resolve) => {
      if (!this.ws || !this.session) {
        resolve(null);
        return;
      }

      const handler = (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as BroadcastMessage;
          if (msg.type === "broadcast") {
            this.ws?.off("message", handler);
            resolve(msg);
          }
        } catch {}
      };

      this.ws.on("message", handler);

      this.ws.send(
        JSON.stringify({
          type: "update",
          session: this.session,
          cost,
          tokens,
          durationMs,
        })
      );

      // Timeout
      setTimeout(() => {
        this.ws?.off("message", handler);
        resolve(null);
      }, 1000);
    });
  }

  disconnect(): void {
    if (this.ws && this.session) {
      this.ws.send(
        JSON.stringify({
          type: "unregister",
          provider: this.session.provider,
          sessionId: this.session.sessionId,
        })
      );
    }
    this.ws?.close();
    this.ws = null;
  }
}
