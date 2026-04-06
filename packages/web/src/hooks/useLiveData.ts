/**
 * Live data hook — connects to the Drishti daemon WebSocket for real-time
 * cross-provider token/cost aggregation.
 *
 * Falls back gracefully when the daemon isn't running. Reconnects automatically
 * with exponential backoff on disconnect.
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ─── Types (mirrored from daemon protocol to avoid cross-package import) ────

/** Token breakdown for a single session or aggregation. */
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens?: number;
}

/** Per-model cost/token breakdown from the daemon. */
interface ModelBreakdown {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

/** Per-provider cost/session breakdown from the daemon. */
interface ProviderBreakdown {
  provider: string;
  cost: number;
  sessions: number;
}

/** Aggregated stats the daemon broadcasts to every connected client. */
interface AggregatedStats {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  sessions: number;
  providers: string[];
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
}

/** Broadcast message shape received from the daemon. */
interface BroadcastMessage {
  type: "broadcast";
  yourSession: {
    cost: number;
    tokens: TokenUsage;
  };
  aggregated: AggregatedStats;
}

/** Server messages we might receive. */
type ServerMessage =
  | BroadcastMessage
  | { type: "ack"; success: boolean }
  | { type: "error"; message: string };

// ─── Connection State ──────────────────────────────────────────────────────

export type LiveConnectionStatus = "connecting" | "connected" | "disconnected";

export interface LiveData {
  /** Current connection status to the daemon. */
  status: LiveConnectionStatus;
  /** Aggregated stats from all active sessions across all providers. */
  aggregated: AggregatedStats | null;
  /** Timestamp of the last successful broadcast received. */
  lastUpdate: number | null;
}

// ─── Constants ─────────────────────────────────────────────────────────────

const DAEMON_URL = "ws://127.0.0.1:9876";

/** Initial reconnect delay in ms. Doubles on each failure, capped at MAX. */
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

// ─── Hook ──────────────────────────────────────────────────────────────────

/**
 * Connects to the Drishti daemon WebSocket for real-time aggregated stats.
 *
 * - Sends a register message on connect (identifies as the web dashboard).
 * - Listens for broadcast messages containing aggregated cross-provider data.
 * - Auto-reconnects with exponential backoff when the connection drops.
 * - Returns `status: "disconnected"` when the daemon isn't reachable —
 *   the dashboard can fall back to static JSON in that case.
 */
export function useLiveData(): LiveData {
  const [status, setStatus] = useState<LiveConnectionStatus>("disconnected");
  const [aggregated, setAggregated] = useState<AggregatedStats | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Refs survive re-renders — we need stable references for the WebSocket
  // and reconnect timer so cleanup works correctly.
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const backoffRef = useRef(INITIAL_BACKOFF_MS);
  const mountedRef = useRef(true);

  /** Clear any pending reconnect timer. */
  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  /** Schedule a reconnection attempt with exponential backoff. */
  const scheduleReconnect = useCallback(
    (connectFn: () => void) => {
      clearReconnect();
      const delay = backoffRef.current;
      backoffRef.current = Math.min(delay * 2, MAX_BACKOFF_MS);
      reconnectTimerRef.current = setTimeout(() => {
        if (mountedRef.current) {
          connectFn();
        }
      }, delay);
    },
    [clearReconnect]
  );

  useEffect(() => {
    mountedRef.current = true;

    /** Attempt a WebSocket connection to the daemon. */
    function connect() {
      // Don't pile up connections
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }

      if (!mountedRef.current) return;
      setStatus("connecting");

      let ws: WebSocket;
      try {
        ws = new WebSocket(DAEMON_URL);
      } catch {
        // Browser might throw synchronously if URL is invalid (unlikely here)
        setStatus("disconnected");
        scheduleReconnect(connect);
        return;
      }

      wsRef.current = ws;

      ws.onopen = () => {
        if (!mountedRef.current) {
          ws.close();
          return;
        }
        // Reset backoff on successful connection
        backoffRef.current = INITIAL_BACKOFF_MS;
        setStatus("connected");

        // Register as the web dashboard viewer — the daemon expects a register
        // message from every client. We use a fixed sessionId so multiple
        // dashboard tabs don't create phantom sessions.
        const registerMsg = {
          type: "register",
          session: {
            provider: "web-dashboard",
            sessionId: "tokmeter-web",
            model: "viewer",
            project: "dashboard",
          },
        };
        ws.send(JSON.stringify(registerMsg));
      };

      ws.onmessage = (event) => {
        if (!mountedRef.current) return;
        try {
          const msg = JSON.parse(event.data as string) as ServerMessage;
          if (msg.type === "broadcast") {
            setAggregated(msg.aggregated);
            setLastUpdate(Date.now());
          }
          // ack/error messages are fine to ignore for the dashboard
        } catch {
          // Malformed JSON — ignore, daemon will send the next one
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (mountedRef.current) {
          setStatus("disconnected");
          scheduleReconnect(connect);
        }
      };

      ws.onerror = () => {
        // onerror is always followed by onclose, so we just let onclose
        // handle the reconnect scheduling. No need to duplicate logic.
      };
    }

    // Kick off the first connection attempt
    connect();

    // Cleanup on unmount
    return () => {
      mountedRef.current = false;
      clearReconnect();
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [scheduleReconnect, clearReconnect]);

  return { status, aggregated, lastUpdate };
}
