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

// ─── Async Client (for statusline hooks) ────────────────────────────────

/**
 * Connect to daemon, send update, receive aggregated stats.
 * Races the WebSocket round-trip against a timeout so the statusline stays fast.
 */
export async function syncUpdate(
  session: SessionInfo,
  cost: number,
  tokens: TokenUsage,
  durationMs?: number,
  timeoutMs = 200
): Promise<DaemonResponse> {
  return new Promise<DaemonResponse>((resolve) => {
    try {
      const ws = new WebSocket(DAEMON_URL);
      let settled = false;

      const finish = (result: DaemonResponse) => {
        if (settled) return;
        settled = true;
        try {
          ws.close();
        } catch {}
        resolve(result);
      };

      // Timeout — if daemon doesn't respond in time, move on
      const timer = setTimeout(() => finish({ connected: false }), timeoutMs);

      ws.on("error", () => {
        clearTimeout(timer);
        finish({ connected: false });
      });

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
            clearTimeout(timer);
            finish({
              connected: true,
              yourSession: msg.yourSession,
              aggregated: msg.aggregated,
            });
          }
        } catch {}
      });
    } catch {
      resolve({ connected: false });
    }
  });
}

/**
 * Quick check if daemon is running (waits for actual connection).
 */
export async function isDaemonReachable(timeoutMs = 500): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    try {
      const ws = new WebSocket(DAEMON_URL);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        resolve(false);
      }, timeoutMs);

      ws.on("open", () => {
        clearTimeout(timer);
        ws.close();
        resolve(true);
      });

      ws.on("error", () => {
        clearTimeout(timer);
        resolve(false);
      });
    } catch {
      resolve(false);
    }
  });
}

// ─── Async Client (for MCP server) ──────────────────────────────────────

export class DaemonClient {
  private ws: WebSocket | null = null;
  private session: SessionInfo | null = null;

  async connect(session: SessionInfo, timeoutMs = 3000): Promise<boolean> {
    return new Promise((resolve) => {
      try {
        this.ws = new WebSocket(DAEMON_URL);
        this.session = session;

        const timer = setTimeout(() => {
          try { this.ws?.close(); } catch {}
          resolve(false);
        }, timeoutMs);

        this.ws.on("open", () => {
          clearTimeout(timer);
          this.ws?.send(
            JSON.stringify({
              type: "register",
              session,
            })
          );
          resolve(true);
        });

        this.ws.on("error", () => {
          clearTimeout(timer);
          resolve(false);
        });
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
