/**
 * Drishti Daemon — WebSocket server for cross-provider aggregation
 *
 * Provides real-time token/cost aggregation across multiple AI coding assistants.
 * Each provider's statusline connects, reports session data, and receives
 * aggregated totals from all active sessions.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
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
let httpServer: ReturnType<typeof createHttpServer> | null = null;
let sessionManager: SessionManager | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let saveStateInterval: ReturnType<typeof setInterval> | null = null;
const HTTP_PORT = DAEMON_PORT + 1;

// ─── Auth Token ────────────────────────────────────────────────────────
// Generate a random bearer token on daemon start. Written to a file (mode 0600)
// so only the owning user can read it. All HTTP POST requests must include it.
import { randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";

const DAEMON_TOKEN_FILE = DAEMON_PID_FILE.replace(".pid", ".token");
let _authToken: string | null = null;

function initAuthToken(): void {
  _authToken = randomBytes(32).toString("hex");
  writeFileSync(DAEMON_TOKEN_FILE, _authToken, { mode: 0o600 });
}

function checkAuth(req: IncomingMessage): boolean {
  if (!_authToken) return true; // no token = dev mode
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${_authToken}`;
}

// Client tracking: WebSocket -> { provider, sessionId }
const clientSessions = new Map<WebSocket, { provider: string; sessionId: string }>();

// ─── Main Server ────────────────────────────────────────────────────────

export function startDaemon(): void {
  if (wss) {
    console.log("Daemon already running");
    return;
  }

  sessionManager = new SessionManager();
  initAuthToken();

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
    saveStateInterval = setInterval(() => {
      saveState();
    }, 10_000);

    // Start HTTP API server alongside WebSocket
    startHttpApi();
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
        console.log(
          `Session: ${msg.session.provider}/${msg.session.sessionId} (${msg.session.model})`
        );
      } else if (existing.model !== msg.session.model) {
        console.log(
          `Model switch: ${msg.session.provider}/${msg.session.sessionId} ${existing.model} → ${msg.session.model}`
        );
      }
      send(ws, { type: "ack", success: true });
      broadcast();
      break;
    }

    case "update": {
      const existing = sessionManager.get(msg.session.provider, msg.session.sessionId);
      if (!existing) {
        console.log(
          `Session: ${msg.session.provider}/${msg.session.sessionId} (${msg.session.model})`
        );
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
  // Save state one final time before stopping
  saveState();

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (saveStateInterval) {
    clearInterval(saveStateInterval);
    saveStateInterval = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  // Clean up PID and token files
  for (const f of [DAEMON_PID_FILE, DAEMON_TOKEN_FILE]) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }

  _authToken = null;
  sessionManager = null;
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

// ─── HTTP REST API ──────────────────────────────────────────────────────

/** Cached core for HTTP API (same 5s TTL pattern as MCP server). */
let _httpCore: { core: any; ts: number } | null = null;
const HTTP_CACHE_TTL = 5_000;
const MAX_BODY_BYTES = 1_048_576; // 1MB

/**
 * API version sent on every response as `X-Drishti-API: drishti-api/N`.
 * Native clients (TokmeterBar.app) check the MAJOR version on every request
 * and surface a clear "incompatible daemon" error if they disagree.
 *
 * Bump this whenever the response shape of any GET endpoint changes in a
 * non-backward-compatible way (renamed field, removed field, type change).
 */
const DRISHTI_API_VERSION = 1;

async function getHttpCore(): Promise<any> {
  const now = Date.now();
  if (_httpCore && now - _httpCore.ts < HTTP_CACHE_TTL) return _httpCore.core;
  const { TokmeterCore } = await import("@sriinnu/tokmeter-core");
  const core = new TokmeterCore();
  await core.scan();
  _httpCore = { core, ts: now };
  return core;
}

function startHttpApi(): void {
  httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS: localhost only — prevents malicious websites from hitting the API
    const origin = req.headers.origin ?? "";
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(origin);
    res.setHeader("Access-Control-Allow-Origin", isLocalhost ? origin : "http://localhost");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Expose-Headers", "X-Drishti-API");
    res.setHeader("Content-Type", "application/json");
    res.setHeader("X-Drishti-API", `drishti-api/${DRISHTI_API_VERSION}`);
    // Hardening headers
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = req.url ?? "/";

    try {
      const { CleanupService } = await import("@sriinnu/tokmeter-core");

      // GET endpoints (use cached core)
      if (req.method === "GET") {
        const core = await getHttpCore();

        if (url === "/api/projects") {
          json(res, core.getAllProjects());
        } else if (url.startsWith("/api/projects/")) {
          const name = decodeURIComponent(url.slice("/api/projects/".length));
          json(res, core.getProjectSummary(name) ?? { error: "Not found" });
        } else if (url === "/api/stats") {
          json(res, core.getStats());
        } else if (url === "/api/models") {
          json(res, core.getModelCosts());
        } else if (url === "/api/daily") {
          json(res, core.getDailyBreakdown());
        } else if (url === "/api/providers") {
          json(res, core.getProviderBreakdown());
        } else if (url === "/api/backups") {
          const service = new CleanupService(core);
          json(res, service.listBackups());
        } else if (url === "/api/themes") {
          const { listThemes } = await import("@sriinnu/tokmeter-core");
          json(res, listThemes());
        } else {
          res.writeHead(404);
          json(res, { error: "Not found", endpoints: ["/api/projects", "/api/stats", "/api/models", "/api/daily", "/api/providers", "/api/backups", "/api/themes", "/api/cleanup/preview", "/api/cleanup/execute", "/api/restore"] });
        }
        return;
      }

      // POST endpoints (fresh core for mutations) — require auth token
      if (req.method === "POST") {
        if (!checkAuth(req)) {
          res.writeHead(401);
          json(res, { error: "Unauthorized — include Authorization: Bearer <token> from " + DAEMON_TOKEN_FILE });
          return;
        }
        const body = await readBody(req);

        if (url === "/api/cleanup/preview") {
          const core = await getHttpCore();
          const service = new CleanupService(core);
          const { project, providers, since, until, today, week, month } = body;
          const preview = await service.preview({ project, providers, since, until, today, week, month });
          json(res, preview);
        } else if (url === "/api/cleanup/execute") {
          if (body.confirm !== "DELETE") {
            res.writeHead(403);
            json(res, { error: "confirm must be 'DELETE'" });
            return;
          }
          const { TokmeterCore } = await import("@sriinnu/tokmeter-core");
          const core = new TokmeterCore();
          const service = new CleanupService(core);
          const { project, providers, since, until, today, week, month, backup } = body;
          const result = await service.execute(
            { project, providers, since, until, today, week, month },
            { backup: backup ?? true },
          );
          _httpCore = null; // Invalidate cache after mutation
          json(res, result);
        } else if (url === "/api/restore") {
          if (body.confirm !== "RESTORE") {
            res.writeHead(403);
            json(res, { error: "confirm must be 'RESTORE'" });
            return;
          }
          const { TokmeterCore } = await import("@sriinnu/tokmeter-core");
          const core = new TokmeterCore({ skipPricing: true });
          const service = new CleanupService(core);
          const result = service.restore(body.backup_id);
          _httpCore = null; // Invalidate cache after mutation
          json(res, result);
        } else {
          res.writeHead(404);
          json(res, { error: "Not found" });
        }
        return;
      }

      res.writeHead(405);
      json(res, { error: "Method not allowed" });
    } catch (err) {
      res.writeHead(500);
      json(res, { error: "Internal server error" });
    }
  });

  httpServer.on("error", (err: Error & { code?: string }) => {
    if (err.code === "EADDRINUSE") {
      console.error(`HTTP API port ${HTTP_PORT} already in use — API disabled`);
    } else {
      console.error("HTTP API error:", err.message);
    }
  });

  httpServer.listen(HTTP_PORT, DAEMON_HOST, () => {
    console.log(`【♾️】 HTTP API listening on http://${DAEMON_HOST}:${HTTP_PORT}`);
    console.log(`   Auth token: ${DAEMON_TOKEN_FILE}`);
  });
}

function json(res: ServerResponse, data: unknown): void {
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    req.on("data", (chunk: Buffer) => {
      totalSize += chunk.length;
      if (totalSize > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf-8")));
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
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
