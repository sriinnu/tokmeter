/**
 * Drishti Daemon — WebSocket server for cross-provider aggregation
 *
 * Provides real-time token/cost aggregation across multiple AI coding assistants.
 * Each provider's statusline connects, reports session data, and receives
 * aggregated totals from all active sessions.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { homedir } from "node:os";
import type { ScanWarning, TokmeterSummary } from "@sriinnu/tokmeter";
import { refreshKoshaRegistry } from "@sriinnu/tokmeter";
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

    // Warm the HTTP core asynchronously so the first user request doesn't
    // pay the full-disk-scan tax. We don't await — the WebSocket server is
    // already up so other clients aren't blocked.
    void getHttpCore()
      .then(() => {
        console.log("【♾️】 HTTP core warm — ready to serve");
      })
      .catch((err) => {
        console.error("HTTP core warmup failed:", err);
      });
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
      clientSessions.set(ws, {
        provider: msg.session.provider,
        sessionId: msg.session.sessionId,
      });
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
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
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

export function getDaemonStatus(): {
  running: boolean;
  pid?: number;
  port: number;
} {
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
 * Tracks the in-flight scan so concurrent callers don't trigger duplicate
 * scans. The first caller does the work; subsequent callers await the same
 * promise.
 */
let _httpCorePromise: Promise<any> | null = null;
/** True once the first warmup scan has completed. */
let _httpCoreReady = false;

/**
 * API version sent on every response as `X-Drishti-API: drishti-api/N`.
 * Native clients (TokmeterBar.app) check the MAJOR version on every request
 * and surface a clear "incompatible daemon" error if they disagree.
 *
 * Bump this whenever the response shape of any GET endpoint changes in a
 * non-backward-compatible way (renamed field, removed field, type change).
 */
const DRISHTI_API_VERSION = 1;
const SUMMARY_SOURCE_HEADER = "X-Tokmeter-Summary-Source";

async function getHttpCore(): Promise<any> {
  const now = Date.now();
  if (_httpCore && now - _httpCore.ts < HTTP_CACHE_TTL) return _httpCore.core;

  // Coalesce concurrent callers — only one scan runs at a time. Without
  // this, the menubar app + a browser tab + an MCP tool can all trigger
  // the same expensive scan in parallel.
  if (_httpCorePromise) return _httpCorePromise;

  _httpCorePromise = (async () => {
    try {
      const { TokmeterCore } = await import("@sriinnu/tokmeter");
      const core = new TokmeterCore();
      await core.scan();
      _httpCore = { core, ts: Date.now() };
      _httpCoreReady = true;
      return core;
    } finally {
      _httpCorePromise = null;
    }
  })();

  return _httpCorePromise;
}

async function getHttpSummaryPayload(): Promise<{
  summary: TokmeterSummary;
  source: "live" | "cache";
}> {
  try {
    const core = await getHttpCore();
    return {
      summary: core.getSummary(),
      source: "live",
    };
  } catch (error) {
    const { loadSummaryCache } = await import("@sriinnu/tokmeter");
    const cached = loadSummaryCache(homedir());

    if (cached.summary) {
      return {
        summary: appendSummaryWarnings(
          cached.summary,
          [
            ...cached.warnings,
            {
              scope: "cache",
              message: `Live summary refresh failed — serving persisted cache (${toErrorMessage(error)}).`,
            },
          ],
          "snapshot-only"
        ),
        source: "cache",
      };
    }

    throw error;
  }
}

function startHttpApi(): void {
  httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    // CORS: localhost only — prevents malicious websites from hitting the API
    const origin = req.headers.origin ?? "";
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(origin);
    res.setHeader("Access-Control-Allow-Origin", isLocalhost ? origin : "http://localhost");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Expose-Headers", `X-Drishti-API, ${SUMMARY_SOURCE_HEADER}`);
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
      const { CleanupService } = await import("@sriinnu/tokmeter");

      // GET endpoints
      if (req.method === "GET") {
        // Fast endpoints — never trigger a fresh scan, just report state.
        // /api/ready is a tiny health check the menubar uses to know whether
        // it's worth firing the slow endpoints yet.
        if (url === "/api/ready") {
          json(res, {
            ready: _httpCoreReady,
            warming: _httpCorePromise !== null,
            apiVersion: DRISHTI_API_VERSION,
          });
          return;
        }

        // /api/quick returns just the stats from whatever cache is available.
        // If the core has never been scanned, returns zeros + ready: false so
        // the UI can render a skeleton instead of timing out.
        if (url === "/api/quick") {
          if (_httpCore) {
            const stats = _httpCore.core.getStats();
            json(res, { ready: true, stats });
          } else {
            // Kick off the warmup but don't wait for it.
            void getHttpCore().catch(() => {});
            json(res, {
              ready: false,
              stats: {
                totalCost: 0,
                totalTokens: 0,
                activeDays: 0,
                projects: 0,
                longestStreak: 0,
              },
            });
          }
          return;
        }

        // Slow endpoints — wait for the core to be ready.
        if (url === "/api/summary") {
          const { summary, source } = await getHttpSummaryPayload();
          res.setHeader(SUMMARY_SOURCE_HEADER, source);
          json(res, summary);
          return;
        }

        const core = await getHttpCore();

        if (url === "/api/projects") {
          json(res, core.getAllProjects());
        } else if (url === "/api/sessions") {
          // All projects across providers, sorted by most-recently-used descending.
          // Used by the menubar's expandable session list — supports 10/20/50+ items.
          const projects = core
            .getAllProjects()
            .slice()
            .sort((a: { lastUsed: number }, b: { lastUsed: number }) => b.lastUsed - a.lastUsed);
          json(res, projects.slice(0, 50));
        } else if (url.startsWith("/api/projects/")) {
          const name = decodeURIComponent(url.slice("/api/projects/".length));
          json(res, core.getProjectSummary(name) ?? { error: "Not found" });
        } else if (url === "/api/stats") {
          json(res, core.getStats());
        } else if (url === "/api/models") {
          json(res, core.getModelCosts());
        } else if (url === "/api/today-models") {
          const core = await getHttpCore();
          json(res, core.getModelCosts({ today: true }));
        } else if (url === "/api/update-pricing") {
          try {
            await refreshKoshaRegistry();
            _httpCore = null;
            json(res, { ok: true });
          } catch (err) {
            res.writeHead(500);
            json(res, {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } else if (url === "/api/daily") {
          json(res, core.getDailyBreakdown());
        } else if (url === "/api/providers") {
          json(res, core.getProviderBreakdown());
        } else if (url === "/api/backups") {
          const service = new CleanupService(core);
          json(res, service.listBackups());
        } else if (url === "/api/themes") {
          const { listThemes } = await import("@sriinnu/tokmeter");
          json(res, listThemes());
        } else {
          res.writeHead(404);
          json(res, {
            error: "Not found",
            endpoints: [
              "/api/ready",
              "/api/quick",
              "/api/summary",
              "/api/projects",
              "/api/sessions",
              "/api/stats",
              "/api/models",
              "/api/daily",
              "/api/providers",
              "/api/backups",
              "/api/themes",
              "/api/cleanup/preview",
              "/api/cleanup/execute",
              "/api/restore",
            ],
          });
        }
        return;
      }

      // POST endpoints (fresh core for mutations) — require auth token
      if (req.method === "POST") {
        if (!checkAuth(req)) {
          res.writeHead(401);
          json(res, {
            error: `Unauthorized — include Authorization: Bearer <token> from ${DAEMON_TOKEN_FILE}`,
          });
          return;
        }
        const body = await readBody(req);

        if (url === "/api/cleanup/preview") {
          const core = await getHttpCore();
          const service = new CleanupService(core);
          const { project, providers, since, until, today, week, month } = body;
          const preview = await service.preview({
            project,
            providers,
            since,
            until,
            today,
            week,
            month,
          });
          json(res, preview);
        } else if (url === "/api/cleanup/execute") {
          if (body.confirm !== "DELETE") {
            res.writeHead(403);
            json(res, { error: "confirm must be 'DELETE'" });
            return;
          }
          const { TokmeterCore } = await import("@sriinnu/tokmeter");
          const core = new TokmeterCore();
          const service = new CleanupService(core);
          const { project, providers, since, until, today, week, month, backup } = body;
          const result = await service.execute(
            { project, providers, since, until, today, week, month },
            { backup: backup ?? true }
          );
          _httpCore = null; // Invalidate cache after mutation
          json(res, result);
        } else if (url === "/api/restore") {
          if (body.confirm !== "RESTORE") {
            res.writeHead(403);
            json(res, { error: "confirm must be 'RESTORE'" });
            return;
          }
          const { TokmeterCore } = await import("@sriinnu/tokmeter");
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
    } catch {
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

function appendSummaryWarnings(
  summary: TokmeterSummary,
  warnings: ScanWarning[],
  todayState: TokmeterSummary["meta"]["todayState"]
): TokmeterSummary {
  return {
    ...summary,
    meta: {
      ...summary.meta,
      todayState,
      warnings: [...summary.meta.warnings, ...warnings],
    },
  };
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

/**
 * Internal flag: when the process is the DETACHED daemon child, it runs
 * `startDaemon()` in the foreground. The parent (the CLI the user ran)
 * forks, prints a confirmation, and exits immediately so the terminal
 * isn't left hanging.
 */
const DAEMON_CHILD_FLAG = "__DRISHTI_DAEMON_CHILD__";

export async function runDaemonCLI(command: string): Promise<void> {
  switch (command) {
    case "start":
      if (isDaemonRunning()) {
        console.log("Daemon is already running");
        console.log(getDaemonStatus());
        break;
      }

      // If we ARE the detached child, run the daemon in the foreground.
      if (process.env[DAEMON_CHILD_FLAG] === "1") {
        startDaemon();
        process.on("SIGINT", () => {
          stopDaemon();
          process.exit(0);
        });
        process.on("SIGTERM", () => {
          stopDaemon();
          process.exit(0);
        });
        break;
      }

      // Otherwise, fork a detached child and exit the parent immediately.
      // This is the classic Unix daemonization pattern — the user's terminal
      // gets its prompt back right away, the daemon runs in the background,
      // and closing the terminal doesn't kill the daemon.
      //
      // We use spawn() instead of fork() because fork() inherits the ESM
      // module graph and can't be combined with top-level require(). spawn()
      // starts a clean Node process with the same argv.
      {
        const { spawn } = await import("node:child_process");
        const child = spawn(process.execPath, [process.argv[1], "daemon", "start"], {
          detached: true,
          stdio: "ignore",
          env: { ...process.env, [DAEMON_CHILD_FLAG]: "1" },
        });
        child.unref();

        // Give the child a moment to write the PID file, then confirm.
        await new Promise((r) => setTimeout(r, 800));
        if (isDaemonRunning()) {
          console.log("【♾️】 Drishti Daemon started (background)");
          console.log(getDaemonStatus());
        } else {
          console.log("【♾️】 Daemon starting… (check `drishti daemon status` in a moment)");
        }
        process.exit(0);
      }
      break;

    case "stop":
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) {
          process.kill(pid, "SIGTERM");
          // Wait for the daemon to actually exit and clean up its PID file.
          let stopRetries = 10;
          while (stopRetries > 0 && isDaemonRunning()) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            stopRetries--;
          }
          console.log(isDaemonRunning() ? "Daemon still shutting down…" : "Daemon stopped");
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
        if (pid) {
          process.kill(pid, "SIGTERM");
          // Wait for old process to die
          let retries = 10;
          while (retries > 0 && isDaemonRunning()) {
            // Busy-wait 200ms — can't use require() in ESM, and this
            // only runs during an explicit user-initiated restart.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            retries--;
          }
        }
      }
      // Delegate to "start" which handles forking
      await runDaemonCLI("start");
      break;

    default:
      console.log("Usage: drishti daemon [start|stop|status|restart]");
  }
}
