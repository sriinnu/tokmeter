/**
 * Tokmeter daemon — WebSocket server for cross-provider aggregation
 *
 * Provides real-time token/cost aggregation across multiple AI coding assistants.
 * Each provider's statusline connects, reports session data, and receives
 * aggregated totals from all active sessions.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import type { IncomingMessage } from "node:http";
import { setPriority } from "node:os";
import { ensureCursorHook, loadConfig, pollAntigravityLiveStatus } from "@sriinnu/tokmeter";
import { WebSocket, WebSocketServer } from "ws";
import {
  closeHttpApi,
  flushHttpCoreRecordCache,
  getWarmHttpCoreEntry,
  HTTP_PORT,
  startHttpApi,
  warmHttpCore,
} from "./http-api.js";
import {
  clearAuthToken,
  getAuthToken,
  initAuthToken,
  isAllowedHttpHost,
  isValidAuthHeader,
  writeSecretFile,
} from "./http-auth.js";
import { captureDaemonIdentity, inspectDaemon, readProcessEvidence } from "./identity.js";
import { capDaemonLogs, LOG_CAP_CHECK_MS } from "./log-cap.js";
import type { BroadcastMessage, ClientMessage, ServerMessage } from "./protocol.js";
import {
  DAEMON_HOST,
  DAEMON_IDENTITY_FILE,
  DAEMON_PID_FILE,
  DAEMON_PORT,
  DAEMON_STATE_DIR,
  DAEMON_STATE_FILE,
  DAEMON_TOKEN_FILE,
  DAEMON_URL,
  LEGACY_DAEMON_PID_FILE,
  LEGACY_DAEMON_TOKEN_FILE,
} from "./protocol.js";
import { SessionManager } from "./session.js";
import { sessionLedgerForTranscript } from "./snapshots.js";

export { runDaemonCLI, waitForDaemonExit } from "./cli-commands.js";
export {
  computeStatsFloor,
  computeTodayFloor,
  type StatsFloor,
  type TodayTotals,
  todayTotalsFrom,
} from "./floors.js";
export { createDaemonTestHttpServer } from "./http-api.js";
export { isAllowedHttpHost, isValidAuthHeader } from "./http-auth.js";
export {
  executeScopedRoute,
  parseDaemonScopeQuery,
  type ScopedRouteResult,
} from "./scoped-routes.js";
export {
  type BarSnapshotResponse,
  buildBarSnapshot,
  buildStatuslineContext,
  type StatuslineContextResponse,
} from "./snapshots.js";

// ─── Server State ───────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let sessionManager: SessionManager | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let saveStateInterval: ReturnType<typeof setInterval> | null = null;
let antigravityLivePollInterval: ReturnType<typeof setInterval> | null = null;
let cursorHookInterval: ReturnType<typeof setInterval> | null = null;
let logCapInterval: ReturnType<typeof setInterval> | null = null;
let _ownsDaemonState = false;

/** How often the daemon re-checks the Cursor hook (it also checks at start). */
const CURSOR_HOOK_CHECK_MS = 24 * 60 * 60 * 1000;
const HTTP_BIND_FAILURE_EXIT_DELAY_MS = 60_000;

async function keepCursorHook(): Promise<void> {
  if (process.env.VITEST) return;
  const result = await ensureCursorHook({ enabled: loadConfig().daemon.cursorHook });
  if (result.action === "installed" || result.action === "refreshed") {
    console.log(
      `【♾️】 Cursor hook ${result.action}: Cursor turns' token usage is now recorded. ` +
        "Remove with `tokmeter cursor-hook uninstall` or daemon.cursorHook=false."
    );
  } else if (result.action === "skipped" && result.reason === "removed-by-hand") {
    console.log("【♾️】 Cursor hook was removed from hooks.json by hand; leaving it off.");
  } else if (result.action === "error") {
    console.error(`Cursor hook check failed: ${result.message}`);
  }
}

/**
 * Allow a WebSocket handshake only from a localhost origin or from a native
 * client that sends no Origin header (the bar app, CLI).
 */
export function isAllowedWsOrigin(origin?: string): boolean {
  if (!origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

// Client tracking: WebSocket -> most-recent { provider, sessionId }
const clientSessions = new Map<WebSocket, { provider: string; sessionId: string }>();
const clientTouched = new Map<WebSocket, Map<string, { provider: string; sessionId: string }>>();
const MAX_WS_CLIENTS = 128;
const MAX_SESSIONS_PER_CLIENT = 64;
const touchedKey = (provider: string, sessionId: string) => JSON.stringify([provider, sessionId]);

function canTrackTouched(ws: WebSocket, provider: string, sessionId: string): boolean {
  const touched = clientTouched.get(ws);
  return (
    !touched ||
    touched.has(touchedKey(provider, sessionId)) ||
    touched.size < MAX_SESSIONS_PER_CLIENT
  );
}

function trackTouched(ws: WebSocket, provider: string, sessionId: string): void {
  let set = clientTouched.get(ws);
  if (!set) {
    set = new Map();
    clientTouched.set(ws, set);
  }
  set.set(touchedKey(provider, sessionId), { provider, sessionId });
}

function refuseStartup(err: Error & { code?: string }): void {
  console.error(
    err.code === "EADDRINUSE"
      ? `HTTP API port ${DAEMON_HOST}:${HTTP_PORT} is already in use by another process. ` +
          "Refusing to start: no auth token was written. Free the port " +
          `(\`lsof -nP -iTCP:${HTTP_PORT} -sTCP:LISTEN\`) and start the daemon again.`
      : `HTTP API could not bind ${DAEMON_HOST}:${HTTP_PORT} (${err.message}). ` +
          "Refusing to start: no auth token was written."
  );
  stopDaemon();
  process.exitCode = 1;
  setTimeout(() => process.exit(1), HTTP_BIND_FAILURE_EXIT_DELAY_MS);
}

// ─── Main Server ────────────────────────────────────────────────────────

export function startDaemon(): void {
  if (wss) {
    console.log("Daemon already running");
    return;
  }

  capDaemonLogs(DAEMON_STATE_DIR);

  try {
    setPriority(0, 10);
  } catch {
    // Non-fatal — OS may clamp priority range.
  }

  sessionManager = new SessionManager();

  wss = new WebSocketServer({
    port: DAEMON_PORT,
    host: DAEMON_HOST,
    maxPayload: 65_536,
    verifyClient: ({ origin, req }: { origin?: string; req: IncomingMessage }) =>
      Boolean(req.headers.host) &&
      isAllowedHttpHost(req.headers.host) &&
      isAllowedWsOrigin(origin) &&
      isValidAuthHeader(req.headers.authorization, getAuthToken()),
  });

  wss.on("listening", () => {
    const evidence = readProcessEvidence(process.pid);
    if (!evidence) {
      console.error("Cannot verify this daemon process; refusing to publish credentials");
      stopDaemon();
      process.exitCode = 1;
      return;
    }
    startHttpApi({
      getSessionManager: () => sessionManager,
      onListening: () => publishAndRun(evidence),
      onBindError: (err) => refuseStartup(err),
    });
  });

  const publishAndRun = (evidence: NonNullable<ReturnType<typeof readProcessEvidence>>) => {
    if (!wss) return;
    _ownsDaemonState = true;
    initAuthToken();
    writeSecretFile(
      DAEMON_IDENTITY_FILE,
      JSON.stringify(captureDaemonIdentity(process.pid, evidence))
    );
    console.log(`【♾️】 Tokmeter daemon listening on ${DAEMON_URL}`);

    writeSecretFile(DAEMON_PID_FILE, String(process.pid));
    try {
      writeSecretFile(LEGACY_DAEMON_PID_FILE, String(process.pid));
    } catch {
      /* legacy path optional */
    }

    cleanupInterval = setInterval(() => {
      const cleaned = sessionManager?.cleanupStale() ?? 0;
      if (cleaned > 0) {
        console.log(`Cleaned ${cleaned} stale sessions`);
      }
    }, 30_000);

    saveStateInterval = setInterval(() => {
      saveState();
      reassertLegacyShims();
    }, 10_000);

    if (loadConfig().daemon.antigravityLivePolling) {
      const scanIntervalMs = Math.max(loadConfig().daemon.scanIntervalSeconds, 30) * 1000;
      antigravityLivePollInterval = setInterval(() => {
        void pollAntigravityLiveStatus().catch(() => {});
      }, scanIntervalMs);
    }

    void keepCursorHook().catch(() => {});
    cursorHookInterval = setInterval(() => {
      void keepCursorHook().catch(() => {});
    }, CURSOR_HOOK_CHECK_MS);
    cursorHookInterval.unref?.();

    logCapInterval = setInterval(() => capDaemonLogs(DAEMON_STATE_DIR), LOG_CAP_CHECK_MS);
    logCapInterval.unref?.();

    warmHttpCore();
  };

  wss.on("connection", (ws) => {
    if (wss && wss.clients.size > MAX_WS_CLIENTS) {
      ws.close(1013, "Too many clients");
      return;
    }
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString()) as ClientMessage;
        handleMessage(ws, msg);
      } catch (_err) {
        send(ws, { type: "error", message: "Invalid message format" });
      }
    });

    ws.on("close", () => {
      const touched = clientTouched.get(ws);
      if (touched && sessionManager) {
        for (const { provider, sessionId } of touched.values()) {
          sessionManager.disconnect(provider, sessionId);
        }
      }
      clientSessions.delete(ws);
      clientTouched.delete(ws);
      broadcast();
    });

    ws.on("error", (err) => {
      console.error("WebSocket error:", err.message);
    });
  });

  wss.on("error", (err: Error & { code?: string }) => {
    if (err.code === "EADDRINUSE") {
      console.log(`daemon port ${DAEMON_PORT} already in use — startup skipped`);
      process.exit(0);
    }
    console.error("Server error:", err.message);
  });

  loadState();
}

// ─── Message Handling ───────────────────────────────────────────────────

function handleMessage(ws: WebSocket, msg: ClientMessage): void {
  if (!sessionManager) return;

  switch (msg.type) {
    case "register": {
      if (!canTrackTouched(ws, msg.session.provider, msg.session.sessionId)) {
        send(ws, { type: "error", message: "Too many sessions for one client" });
        return;
      }
      const existing = sessionManager.get(msg.session.provider, msg.session.sessionId);
      if (!sessionManager.register(msg.session)) {
        send(ws, { type: "error", message: "Session limit reached or invalid session" });
        return;
      }
      clientSessions.set(ws, {
        provider: msg.session.provider,
        sessionId: msg.session.sessionId,
      });
      trackTouched(ws, msg.session.provider, msg.session.sessionId);
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
      if (!canTrackTouched(ws, msg.session.provider, msg.session.sessionId)) {
        send(ws, { type: "error", message: "Too many sessions for one client" });
        return;
      }
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
        msg.durationMs,
        msg.contextWindow,
        {
          model: msg.session.model,
          project: msg.session.project,
          cwd: msg.session.cwd,
          transcriptPath: msg.session.transcriptPath,
        }
      );

      if (session) {
        clientSessions.set(ws, {
          provider: msg.session.provider,
          sessionId: msg.session.sessionId,
        });
        trackTouched(ws, msg.session.provider, msg.session.sessionId);
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
  const httpCore = getWarmHttpCoreEntry();

  for (const ws of wss.clients) {
    if (ws.readyState !== WebSocket.OPEN) continue;

    const clientSession = clientSessions.get(ws);
    if (!clientSession) continue;

    const session = sessionManager.get(clientSession.provider, clientSession.sessionId);
    if (!session) continue;

    const aggregated = sessionManager.getAggregated({
      provider: clientSession.provider,
      sessionId: clientSession.sessionId,
    });

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

    const ledger =
      session.transcriptPath && httpCore
        ? sessionLedgerForTranscript(session.transcriptPath, httpCore.core.getHomeDir?.())
        : null;

    const msg: BroadcastMessage = {
      type: "broadcast",
      yourSession: {
        cost: session.cost,
        tokens: session.tokens,
        ...(ledger ? { ledger } : {}),
      },
      aggregated: fullAggregated,
    };

    send(ws, msg);
  }
}

const WS_MAX_BUFFERED_BYTES = 1_000_000;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) return;
  ws.send(JSON.stringify(msg));
}

// ─── State Persistence ──────────────────────────────────────────────────

function saveState(): void {
  if (!sessionManager) return;

  const state = {
    sessions: sessionManager.getAll().map((s) => ({
      ...s,
      connected: false,
    })),
    savedAt: Date.now(),
  };

  try {
    const tmp = `${DAEMON_STATE_FILE}.${process.pid}.tmp`;
    const fd = openSync(tmp, "w", 0o600);
    try {
      writeSync(fd, JSON.stringify(state, null, 2));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, DAEMON_STATE_FILE);
  } catch {
    // Ignore save errors
  }
}

function reassertLegacyShims(): void {
  try {
    if (!existsSync(LEGACY_DAEMON_PID_FILE)) {
      writeSecretFile(LEGACY_DAEMON_PID_FILE, String(process.pid));
    }
  } catch {
    /* legacy path optional */
  }
  try {
    const token = getAuthToken();
    if (token && !existsSync(LEGACY_DAEMON_TOKEN_FILE)) {
      writeSecretFile(LEGACY_DAEMON_TOKEN_FILE, token);
    }
  } catch {
    /* legacy clients just won't authenticate POSTs until next tick */
  }
}

function loadState(): void {
  if (!sessionManager || !existsSync(DAEMON_STATE_FILE)) return;

  try {
    const data = JSON.parse(readFileSync(DAEMON_STATE_FILE, "utf-8"));
    console.log(`Loaded state from ${new Date(data.savedAt).toISOString()}`);
  } catch {
    // Ignore load errors
  }
}

// ─── Daemon Management ──────────────────────────────────────────────────

export function stopDaemon(): void {
  if (_ownsDaemonState) {
    saveState();
    flushHttpCoreRecordCache();
  }

  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
  if (saveStateInterval) {
    clearInterval(saveStateInterval);
    saveStateInterval = null;
  }
  if (antigravityLivePollInterval) {
    clearInterval(antigravityLivePollInterval);
    antigravityLivePollInterval = null;
  }
  if (cursorHookInterval) {
    clearInterval(cursorHookInterval);
    cursorHookInterval = null;
  }
  if (logCapInterval) {
    clearInterval(logCapInterval);
    logCapInterval = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }

  closeHttpApi();

  const ownsPid =
    _ownsDaemonState &&
    (() => {
      try {
        return readFileSync(DAEMON_PID_FILE, "utf8").trim() === String(process.pid);
      } catch {
        return false;
      }
    })();
  for (const f of ownsPid
    ? [
        DAEMON_IDENTITY_FILE,
        DAEMON_PID_FILE,
        DAEMON_TOKEN_FILE,
        LEGACY_DAEMON_PID_FILE,
        LEGACY_DAEMON_TOKEN_FILE,
      ]
    : []) {
    try {
      unlinkSync(f);
    } catch {
      /* ignore */
    }
  }

  clearAuthToken();
  _ownsDaemonState = false;
  sessionManager = null;
  console.log("Daemon stopped");
}

export function isDaemonRunning(): boolean {
  return getDaemonStatus().running;
}

export function getDaemonStatus(): {
  running: boolean;
  pid?: number;
  port: number;
  identity: "verified" | "absent" | "unverified";
} {
  const owner = inspectDaemon(DAEMON_PID_FILE, DAEMON_IDENTITY_FILE);
  return owner.state === "verified"
    ? { running: true, pid: owner.identity.pid, port: DAEMON_PORT, identity: owner.state }
    : { running: false, port: DAEMON_PORT, identity: owner.state };
}
