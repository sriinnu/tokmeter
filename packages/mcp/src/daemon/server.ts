/**
 * Drishti Daemon — WebSocket server for cross-provider aggregation
 *
 * Provides real-time token/cost aggregation across multiple AI coding assistants.
 * Each provider's statusline connects, reports session data, and receives
 * aggregated totals from all active sessions.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { WebSocket, WebSocketServer } from "ws";
import type { BroadcastMessage, ClientMessage, ServerMessage } from "./protocol.js";
import {
  DAEMON_HOST,
  DAEMON_PID_FILE,
  DAEMON_PORT,
  DAEMON_STATE_FILE,
  DAEMON_URL,
} from "./protocol.js";
import { SessionManager } from "./session.js";

// ─── Server State ───────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let sessionManager: SessionManager | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

// Client tracking: WebSocket -> { provider, sessionId }
const clientSessions = new Map<WebSocket, { provider: string; sessionId: string }>();

// ─── Main Server ────────────────────────────────────────────────────────

export function startDaemon(): void {
  if (wss) {
    console.log("Daemon already running");
    return;
  }

  sessionManager = new SessionManager();

  wss = new WebSocketServer({ port: DAEMON_PORT, host: DAEMON_HOST });

  wss.on("listening", () => {
    console.log(`【♾️】 Drishti Daemon listening on ${DAEMON_URL}`);

    // Write PID file
    writeFileSync(DAEMON_PID_FILE, String(process.pid));

    // Start cleanup interval
    cleanupInterval = setInterval(() => {
      const cleaned = sessionManager?.cleanupStale() ?? 0;
      if (cleaned > 0) {
        console.log(`Cleaned ${cleaned} stale sessions`);
      }
    }, 30_000);

    // Save state periodically
    setInterval(() => {
      saveState();
    }, 10_000);
  });

  wss.on("connection", (ws) => {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        handleMessage(ws, msg);
      } catch (_err) {
        send(ws, { type: "error", message: "Invalid message format" });
      }
    });

    ws.on("close", () => {
      const session = clientSessions.get(ws);
      if (session && sessionManager) {
        sessionManager.disconnect(session.provider, session.sessionId);
      }
      clientSessions.delete(ws);
      broadcast();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });
  });

  wss.on("error", (err) => {
    console.error("Server error:", err.message);
  });

  // Load previous state
  loadState();
}

// ─── Message Handling ───────────────────────────────────────────────────

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  if (!sessionManager) return;

  switch (msg.type) {
    case "register": {
      const existing = sessionManager.get(msg.session.provider, msg.session.sessionId);
      sessionManager.register(msg.session);
      clientSessions.set(ws, { provider: msg.session.provider, sessionId: msg.session.sessionId });
      if (!existing) {
        console.log(`Session: ${msg.session.provider}/${msg.session.sessionId} (${msg.session.model})`);
      } else if (existing.model !== msg.session.model) {
        console.log(`Model switch: ${msg.session.provider}/${msg.session.sessionId} ${existing.model} → ${msg.session.model}`);
      }
      send(ws, { type: "ack", success: true });
      broadcast();
      break;
    }

    case "update": {
      const existing = sessionManager.get(msg.session.provider, msg.session.sessionId);
      if (!existing) {
        console.log(`Session: ${msg.session.provider}/${msg.session.sessionId} (${msg.session.model})`);
      }

      const session = sessionManager.update(
        msg.session.provider,
        msg.session.sessionId,
        msg.cost,
        msg.tokens,
        msg.durationMs
      );

      if (session) {
        clientSessions.set(ws, {
          provider: msg.session.provider,
          sessionId: msg.session.sessionId,
        });
        broadcast();
      }
      break;
    }

    case "unregister": {
      sessionManager.unregister(msg.provider, msg.sessionId);
      clientSessions.delete(ws);
      send(ws, { type: "ack", success: true });
      broadcast();
      break;
    }
  }
}

// ─── Broadcasting ───────────────────────────────────────────────────────

function broadcast(): void {
  if (!wss || !sessionManager) return;

  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    const clientSession = clientSessions.get(ws);
    if (!clientSession) continue;

    const session = sessionManager.get(clientSession.provider, clientSession.sessionId);
    if (!session) continue;

    // Get aggregated stats excluding this session
    const aggregated = sessionManager.getAggregated({
      provider: clientSession.provider,
      sessionId: clientSession.sessionId,
    });

    // Add this session's data to aggregated total
    const fullAggregated: typeof aggregated = {
      ...aggregated,
      totalCost: aggregated.totalCost + session.cost,
      totalInputTokens: aggregated.totalInputTokens + session.tokens.inputTokens,
      totalOutputTokens: aggregated.totalOutputTokens + session.tokens.outputTokens,
      totalCacheTokens:
        aggregated.totalCacheTokens +
        session.tokens.cacheReadTokens +
        session.tokens.cacheWriteTokens,
      sessions: aggregated.sessions + 1,
    };

    const msg: BroadcastMessage = {
      type: "broadcast",
      yourSession: {
        cost: session.cost,
        tokens: session.tokens,
      },
      aggregated: fullAggregated,
    };

    send(ws, msg);
  }
}

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ─── State Persistence ──────────────────────────────────────────────────

function saveState(): void {
  if (!sessionManager) return;

  const state = {
    sessions: sessionManager.getAll().map((s) => ({
      ...s,
      connected: false, // Don't persist connected state
    })),
    savedAt: Date.now(),
  };

  try {
    writeFileSync(DAEMON_STATE_FILE, JSON.stringify(state, null, 2));
  } catch {
    // Ignore save errors
  }
}

function loadState(): void {
  if (!sessionManager || !existsSync(DAEMON_STATE_FILE)) return;

  try {
    const data = JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf-8"));
    // Sessions will re-register on reconnect, so we just use this for
    // historical context if needed
    console.log(`Loaded state from ${new Date(data.savedAt).toISOString()}`);
  } catch {
    // Ignore load errors
  }
}

// ─── Daemon Management ──────────────────────────────────────────────────

export function stopDaemon(): void {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }

  try {
    unlinkSync(DAEMON_PID_FILE);
  } catch {
    // Ignore
  }

  console.log("Daemon stopped");
}

export function isDaemonRunning(): boolean {
  if (!existsSync(DAEMON_PID_FILE)) return false;

  try {
    const pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    // Check if process is running
    process.kill(pid, 0);
    return true;
  } catch {
    // Process not running, clean up PID file
    try {
      unlinkSync(DAEMON_PID_FILE);
    } catch {}
    return false;
  }
}

export function getDaemonStatus(): { running: boolean; pid?: number; port: number } {
  if (!existsSync(DAEMON_PID_FILE)) {
    return { running: false, port: DAEMON_PORT };
  }

  try {
    const pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
    process.kill(pid, 0);
    return { running: true, pid, port: DAEMON_PORT };
  } catch {
    return { running: false, port: DAEMON_PORT };
  }
}

// ─── CLI Entry Point ────────────────────────────────────────────────────

export function runDaemonCLI(command: string): void {
  switch (command) {
    case "start":
      if (isDaemonRunning()) {
        console.log("Daemon is already running");
        console.log(getDaemonStatus());
      } else {
        startDaemon();
        // Keep process alive
        process.on("SIGINT", () => {
          stopDaemon();
          process.exit(0);
        });
        process.on("SIGTERM", () => {
          stopDaemon();
          process.exit(0);
        });
      }
      break;

    case "stop":
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) {
          process.kill(pid, "SIGTERM");
          console.log("Daemon stopped");
        }
      } else {
        console.log("Daemon is not running");
      }
      break;

    case "status":
      console.log(getDaemonStatus());
      break;

    case "restart":
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) process.kill(pid, "SIGTERM");
      }
      setTimeout(() => {
        startDaemon();
        process.on("SIGINT", () => {
          stopDaemon();
          process.exit(0);
        });
      }, 1000);
      break;

    default:
      console.log("Usage: drishti daemon [start|stop|status|restart]");
  }
}
