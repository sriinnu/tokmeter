/**
 * Drishti Daemon — WebSocket server for cross-provider aggregation
 *
 * Provides real-time token/cost aggregation across multiple AI coding assistants.
 * Each provider's statusline connects, reports session data, and receives
 * aggregated totals from all active sessions.
 */

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from "node:http";
import { homedir, setPriority } from "node:os";
import type { ProviderId, ScanWarning, TokmeterSummary } from "@sriinnu/tokmeter";
import {
  loadConfig,
  localDateKey,
  pollAntigravityLiveStatus,
  refreshKoshaRegistry,
} from "@sriinnu/tokmeter";
import { WebSocket, WebSocketServer } from "ws";
import {
  AGENT_LABEL,
  agentPlistPath,
  installAgent,
  isAgentInstalled,
  isAgentLoaded,
  kickstartAgent,
  uninstallAgent,
} from "./launchd.js";
import type { BroadcastMessage, ClientMessage, ServerMessage } from "./protocol.js";
import {
  DAEMON_HOST,
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

// ─── Server State ───────────────────────────────────────────────────────

let wss: WebSocketServer | null = null;
let httpServer: ReturnType<typeof createHttpServer> | null = null;
let sessionManager: SessionManager | null = null;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;
let saveStateInterval: ReturnType<typeof setInterval> | null = null;
let antigravityLivePollInterval: ReturnType<typeof setInterval> | null = null;
const HTTP_PORT = DAEMON_PORT + 1;

/**
 * Allow a WebSocket handshake only from a localhost origin or from a native
 * client that sends no Origin header (the bar app, CLI). A foreign website's
 * connect carries its own Origin and is rejected — the defense against any
 * visited page opening ws://127.0.0.1 to read spend or inject sessions.
 */
export function isAllowedWsOrigin(origin?: string): boolean {
  if (!origin) return true; // native clients send no Origin header
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

/**
 * Validate the HTTP Host header against localhost. This is the DNS-rebinding
 * defense that CORS response headers cannot provide: after an attacker rebinds
 * evil.com → 127.0.0.1, the browser's request is same-origin so CORS never
 * applies, but the Host header still carries the original `evil.com` — reject
 * it. A missing Host (HTTP/1.0, some native clients) is allowed; browsers
 * always send one.
 */
export function isAllowedHttpHost(host?: string): boolean {
  if (!host) return true;
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname === "::1"
  );
}

/**
 * V8 old-space cap (MB) for the spawned daemon child — the guardrail against a
 * runaway scan ballooning the box back into kernel-panic territory.
 *
 * NOTE: this is deliberately MUCH higher than the statusline's 768MB cap. The
 * statusline never scans anymore (it reads the daemon), so 768 is plenty for
 * it. The daemon, by contrast, MUST perform the one-time full-history
 * `scan()` to load frozen history, and on a real power-user corpus that cold
 * scan peaks well past 2GB (measured ~4.5GB peak / ~3.9GB warm on the dev
 * corpus). A 768MB cap here OOM-kills the daemon before it can ever finish
 * warming, which would break the whole architecture (everything reads the
 * daemon). We cap high enough to clear the cold scan with headroom while still
 * bounding true runaway. Tune via TOKMETER_DAEMON_HEAP_MB if a corpus needs
 * more. The held working set is the cost of keeping all history warm — that's
 * the design — but it now lives in ONE singleton, not a stack of scanners.
 */
const DAEMON_HEAP_CAP_MB = Number.parseInt(process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144", 10);

// ─── Auth Token ────────────────────────────────────────────────────────
// Generate a random bearer token on daemon start. Written to a file (mode 0600)
// so only the owning user can read it. All HTTP POST requests must include it.
import { randomBytes, timingSafeEqual } from "node:crypto";

let _authToken: string | null = null;

/**
 * Write `data` to `path` with mode 0600 using `O_CREAT|O_EXCL|O_WRONLY`. The
 * EXCL flag closes the symlink-race / pre-created-file attack: if anything
 * already exists at `path`, the open fails (EEXIST) and we unlink + retry.
 * This is the local-multi-user TOCTOU defense — an attacker cannot pre-create
 * the token file with their own owner/perms and read what we write.
 */
function writeSecretFile(path: string, data: string): void {
  // Best-effort cleanup of any stale file at the path. If it's not ours,
  // the unlink will fail and the open below will EEXIST → we surface.
  try {
    unlinkSync(path);
  } catch {
    /* file may not exist; that's fine — EXCL open will catch races */
  }
  const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
  try {
    writeSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

function initAuthToken(): void {
  _authToken = randomBytes(32).toString("hex");
  // Ensure the state dir exists (and is locked to the owner) before writing.
  try {
    mkdirSync(DAEMON_STATE_DIR, { recursive: true, mode: 0o700 });
  } catch {}
  writeSecretFile(DAEMON_TOKEN_FILE, _authToken);
  // Compat shim for bar v1.4.0 which still reads /tmp/drishti-daemon.token.
  // /tmp is shared, so this is the TOCTOU-exposed copy — best-effort, never
  // fatal. Future bar releases should switch to DAEMON_TOKEN_FILE and we drop
  // this shim.
  try {
    writeSecretFile(LEGACY_DAEMON_TOKEN_FILE, _authToken);
  } catch {
    /* ignore — legacy clients just won't authenticate */
  }
}

/**
 * Pure bearer-token check, split out from {@link checkAuth} so it's testable
 * without spinning up the real daemon (which owns the module-level
 * `_authToken` set once at startup). `token === null` is dev mode (no auth
 * configured) and always passes — matches the daemon's actual first-run
 * behavior before `initAuthToken()` has run.
 */
export function isValidAuthHeader(header: string | undefined, token: string | null): boolean {
  if (!token) return true; // no token = dev mode
  const value = header ?? "";
  const expected = `Bearer ${token}`;
  // Constant-time compare so an attacker can't probe the token via timing.
  // Lengths must match for timingSafeEqual; bail early when they don't, since
  // a length mismatch is itself a public fact (it's the request the attacker
  // sent vs. a fixed-length expected string).
  if (value.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function checkAuth(req: IncomingMessage): boolean {
  return isValidAuthHeader(req.headers.authorization, _authToken);
}

// Client tracking: WebSocket -> most-recent { provider, sessionId } (used to
// exclude the asking session from its own broadcast).
const clientSessions = new Map<WebSocket, { provider: string; sessionId: string }>();
// EVERY session a socket has touched, so `close` can disconnect all of them.
// Without this, a connection that reports >1 sessionId leaves all-but-the-last
// stuck connected:true forever → never reaped by cleanupStale and counted in
// the aggregate indefinitely (unbounded Map growth + permanent spend inflation).
const clientTouched = new Map<WebSocket, Map<string, { provider: string; sessionId: string }>>();

function trackTouched(ws: WebSocket, provider: string, sessionId: string): void {
  let set = clientTouched.get(ws);
  if (!set) {
    set = new Map();
    clientTouched.set(ws, set);
  }
  set.set(`${provider}:${sessionId}`, { provider, sessionId });
}

// ─── Main Server ────────────────────────────────────────────────────────

export function startDaemon(): void {
  if (wss) {
    console.log("Daemon already running");
    return;
  }

  // Lower the daemon's CPU priority so the macOS scheduler keeps interactive
  // UI (Ghostty, Cursor, the menubar) responsive while we GC, refresh today,
  // and aggregate. We are background data infrastructure; we MUST yield to
  // the foreground. Without this, a 200 ms GC pause in a 1.5 GB heap stalls
  // every other process briefly because macOS's compressor and scheduler
  // share global pools — exactly what was murdering Ghostty.
  //
  // +10 = "nice", same as the standard background-daemon convention on Unix.
  // setPriority is best-effort; macOS may clamp to its own range.
  try {
    setPriority(0, 10);
  } catch {
    // Non-fatal — if the OS refuses, the daemon still works, just less polite.
  }

  // Cross-process singleton guard. The statusline + bar both fire-and-forget
  // a `daemon start` when they can't reach the daemon; without this guard a
  // burst of those would spawn a stampede of servers all fighting for the
  // port. If a live daemon already owns the PID file, bow out silently.
  if (existsSync(DAEMON_PID_FILE)) {
    const raw = (() => {
      try {
        return readFileSync(DAEMON_PID_FILE, "utf-8").trim();
      } catch {
        return "";
      }
    })();
    const pid = Number.parseInt(raw, 10);
    if (Number.isFinite(pid) && pid > 1 && pid !== process.pid) {
      // process.kill(pid, 0) probes the process WITHOUT signalling it.
      //   - succeeds         → process exists and is signalable by us → alive, bow out
      //   - throws EPERM     → process exists but is owned by another user (or restricted) → alive, bow out
      //   - throws ESRCH     → no such process → stale PID, safe to reclaim
      //   - throws anything else → conservative: treat as alive (avoid stomping on a real daemon)
      let liveness: "alive" | "stale" = "stale";
      try {
        process.kill(pid, 0);
        liveness = "alive";
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "EPERM") {
          liveness = "alive";
        } else if (code === "ESRCH") {
          liveness = "stale";
        } else {
          // Unknown errno — fail safe by assuming alive. Better to bow out
          // than to double-bind and crash a working daemon.
          liveness = "alive";
        }
      }
      if (liveness === "alive") {
        console.log(`daemon already running (pid ${pid})`);
        return;
      }
      // Stale PID file — clean up both canonical and legacy paths.
      for (const f of [DAEMON_PID_FILE, LEGACY_DAEMON_PID_FILE]) {
        try {
          unlinkSync(f);
        } catch {}
      }
    } else {
      // Garbage PID (empty / non-numeric / self) — treat as stale.
      for (const f of [DAEMON_PID_FILE, LEGACY_DAEMON_PID_FILE]) {
        try {
          unlinkSync(f);
        } catch {}
      }
    }
  }

  sessionManager = new SessionManager();
  initAuthToken();

  wss = new WebSocketServer({
    port: DAEMON_PORT,
    host: DAEMON_HOST,
    // Bound message size like the HTTP body cap — ws defaults to 100 MiB, so a
    // client could otherwise force a 100 MB JSON.parse per frame. Session
    // updates are tiny; 1 MB is generous.
    maxPayload: 1_048_576,
    // Reject cross-origin handshakes. Browsers attach an Origin header to
    // WebSocket connects, and the same-origin policy does NOT block the
    // connection itself — so without this any website the user visits could
    // open ws://127.0.0.1 and read broadcast spend totals or inject/unregister
    // sessions (which then persist via saveState). Native clients (bar, CLI)
    // send no Origin, so allow empty; otherwise require a localhost origin,
    // matching the HTTP API's CORS gate.
    verifyClient: ({ origin }: { origin?: string }) => isAllowedWsOrigin(origin),
  });

  wss.on("listening", () => {
    console.log(`【♾️】 Drishti Daemon listening on ${DAEMON_URL}`);

    // Write PID file (canonical + legacy /tmp shim for bar v1.4.0 compat).
    writeFileSync(DAEMON_PID_FILE, String(process.pid), { mode: 0o600 });
    try {
      writeFileSync(LEGACY_DAEMON_PID_FILE, String(process.pid), { mode: 0o600 });
    } catch {
      /* legacy path optional */
    }

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
      // macOS reaps /tmp files untouched for ~3 days. The legacy pid/token
      // shims are written once at startup, so a daemon that stays up for days
      // loses them to the reaper — after which the macOS bar (which reads
      // /tmp/drishti-daemon.pid) reports "offline" despite a healthy daemon,
      // and a restart can't recover because this live daemon still owns the
      // canonical pidfile and the singleton guard bows out. Re-assert the
      // shims whenever they go missing so the reaper can never outlast us.
      reassertLegacyShims();
    }, 10_000);

    // Poll Antigravity's live credit status (if it's running) on the same
    // cadence as the daemon's own advisory rescan interval. This is a
    // best-effort background signal, not a hot-path read: only this
    // interval ever touches the process/network — readers (CLI, API) only
    // ever read the on-disk snapshot log pollAntigravityLiveStatus appends
    // to. A failed/empty poll (Antigravity not running) is silent, not an
    // error — most of the time nobody has it open.
    //
    // Off by default (daemon.antigravityLivePolling, config-service.ts) —
    // it works by reading a CSRF token out of Antigravity's own process
    // command line and calling an undocumented internal RPC with it. Real
    // enough to automate indefinitely in the background that it needs an
    // explicit, durable opt-in, not just something inferred from a chat.
    if (loadConfig().daemon.antigravityLivePolling) {
      const scanIntervalMs = Math.max(loadConfig().daemon.scanIntervalSeconds, 30) * 1000;
      antigravityLivePollInterval = setInterval(() => {
        void pollAntigravityLiveStatus().catch(() => {
          // best-effort signal — a failure here must never affect anything else
        });
      }, scanIntervalMs);
    }

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
      // Disconnect EVERY session this socket touched, not just the last one.
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
      // Another daemon won the bind race (the PID-file check above has a
      // small TOCTOU window). Exit cleanly rather than crash-looping — the
      // other daemon is the live singleton and there's nothing for us to do.
      console.log(`daemon port ${DAEMON_PORT} already in use — another daemon won the race`);
      process.exit(0);
    }
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
        msg.contextWindow
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

/// A healthy client drains a broadcast instantly, so anything past this in its
/// send buffer means it has stalled — stop feeding it or the buffer grows
/// unbounded until the daemon OOMs.
const WS_MAX_BUFFERED_BYTES = 1_000_000;

function send(ws: WebSocket, msg: ServerMessage): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  if (ws.bufferedAmount > WS_MAX_BUFFERED_BYTES) return; // backpressure: drop for a stalled reader
  ws.send(JSON.stringify(msg));
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
    // Atomic write: a crash mid-write must never leave a truncated JSON that
    // would throw on the next loadState. tmp(pid)+fsync+rename.
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

// Re-create the legacy /tmp pid/token shims if the OS reaper removed them.
// Canonical state lives under $HOME (reaper-safe); only the /tmp copies the
// macOS bar reads are at risk. Cheap existsSync gate — writes only on miss.
function reassertLegacyShims(): void {
  try {
    if (!existsSync(LEGACY_DAEMON_PID_FILE)) {
      writeFileSync(LEGACY_DAEMON_PID_FILE, String(process.pid), { mode: 0o600 });
    }
  } catch {
    /* legacy path optional — canonical pidfile is the source of truth */
  }
  try {
    if (_authToken && !existsSync(LEGACY_DAEMON_TOKEN_FILE)) {
      writeSecretFile(LEGACY_DAEMON_TOKEN_FILE, _authToken);
    }
  } catch {
    /* legacy clients just won't authenticate POSTs until next tick */
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
  if (antigravityLivePollInterval) {
    clearInterval(antigravityLivePollInterval);
    antigravityLivePollInterval = null;
  }

  if (wss) {
    wss.close();
    wss = null;
  }

  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }

  // Clean up PID and token files (canonical + legacy /tmp shims).
  for (const f of [
    DAEMON_PID_FILE,
    DAEMON_TOKEN_FILE,
    LEGACY_DAEMON_PID_FILE,
    LEGACY_DAEMON_TOKEN_FILE,
  ]) {
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

/**
 * Distinguish a truly-dead PID from one we just don't have permission to
 * signal. EPERM ⇒ the process exists (alive); ESRCH ⇒ no such process (stale).
 * Anything else ⇒ unknown — fail conservatively as "alive" so we never blow
 * away the canonical singleton.
 */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    return true; // unknown errno → conservative
  }
}

export function isDaemonRunning(): boolean {
  if (!existsSync(DAEMON_PID_FILE)) return false;
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
  } catch {
    return false;
  }
  if (isPidAlive(pid)) return true;
  // Truly stale — clean up so the next start can reclaim cleanly.
  for (const f of [DAEMON_PID_FILE, LEGACY_DAEMON_PID_FILE]) {
    try {
      unlinkSync(f);
    } catch {}
  }
  return false;
}

export function getDaemonStatus(): {
  running: boolean;
  pid?: number;
  port: number;
} {
  if (!existsSync(DAEMON_PID_FILE)) {
    return { running: false, port: DAEMON_PORT };
  }
  let pid: number;
  try {
    pid = Number.parseInt(readFileSync(DAEMON_PID_FILE, "utf-8").trim(), 10);
  } catch {
    return { running: false, port: DAEMON_PORT };
  }
  if (isPidAlive(pid)) return { running: true, pid, port: DAEMON_PORT };
  return { running: false, port: DAEMON_PORT };
}

// ─── HTTP REST API ──────────────────────────────────────────────────────

/**
 * The daemon holds ONE persistent TokmeterCore for its entire lifetime — the
 * single warm source of truth. Frozen history is scanned once; only TODAY is
 * refreshed incrementally (cheap, stat-pruned to today's active files) on a
 * sane cadence. This is the fix for the RAM blow-up: we no longer build a new
 * core and full-scan the whole corpus on a 5s TTL.
 *
 * `_httpCore` holds the singleton; `ts` is the last time TODAY was refreshed.
 */
let _httpCore: { core: any; ts: number } | null = null;
/**
 * Single chokepoint for invalidating the warm core. Anywhere we null `_httpCore`
 * we MUST also reset `_httpCoreReady` and the today-floor so `/api/ready`
 * doesn't lie ("ready: true" with no warm core) and the floor doesn't pin
 * yesterday's high-water onto a freshly-rebuilt core. Use this helper
 * everywhere instead of `_httpCore = null` so the invariant can't drift.
 */
function invalidateHttpCore(): void {
  _httpCore = null;
  _httpCoreReady = false;
  _todayHighWater = null;
  _statsHighWater = null;
}
/**
 * How stale today's data may get before a warm `refreshToday()` runs. The full
 * frozen history is never re-read here — only today's ~2 active files.
 */
const TODAY_REFRESH_TTL = 12_000;
const MAX_BODY_BYTES = 1_048_576; // 1MB

/**
 * Tracks the in-flight refresh/scan so concurrent callers don't trigger
 * duplicate work. The first caller does the work; subsequent callers await the
 * same promise.
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

/**
 * Set by `rescanHttpCore()` when a pricing update arrives while another core
 * operation is in flight. The in-flight promise will see this on completion
 * and queue exactly one fullRescan after it — collapsing N back-to-back
 * pricing-update bursts into a single follow-up scan instead of stacking N
 * full-corpus scans. Resets to false when consumed.
 */
let _pendingFullRescan = false;

// Guards /api/rescan: the deep rebuild runs in the background, so concurrent
// triggers (impatient double-click) must coalesce, not stack.
let _rescanInFlight = false;

// How many recent days a Deep Rescan re-derives from raw. Covers pace's 7-day
// baseline plus slack, and any day a recent bug could have mis-sealed — while
// staying far below the full-history parse that exhausts memory.
const DEEP_RESCAN_WINDOW_DAYS = 30;

/**
 * Single mediator for ALL core work — warm reads, today refreshes, and full
 * rescans — through ONE single-flight promise. Without this, a concurrent
 * `rescanHttpCore()` could replace `_httpCorePromise` after awaiting it,
 * back-to-back-running TWO full-corpus scans (the exact stampede the rebuild
 * exists to prevent, just serialized instead of parallel).
 *
 * Rules:
 *   - Warm + fresh (within {@link TODAY_REFRESH_TTL}) and no rescan requested
 *     → return the warm core instantly.
 *   - Something already in flight → wait for it. If a rescan was requested
 *     while a refresh was running, mark it pending so we queue exactly one
 *     rescan after the current operation completes.
 *   - Nothing in flight → claim `_httpCorePromise` and run the right work
 *     (refresh / fullRescan / cold start).
 */
async function ensureCoreFresh(forceFullRescan = false, depth = 0): Promise<any> {
  const now = Date.now();
  if (!forceFullRescan && _httpCore && now - _httpCore.ts < TODAY_REFRESH_TTL) {
    return _httpCore.core;
  }

  if (_httpCorePromise) {
    if (forceFullRescan) _pendingFullRescan = true;
    // Tolerate rejection so a single failed scan doesn't poison every caller
    // (the inner finally still clears `_httpCorePromise`).
    await _httpCorePromise.catch(() => undefined);
    // Re-evaluate: the just-finished work may already have satisfied us, or
    // we may need to chain a rescan if `_pendingFullRescan` was set. Cap
    // the recursion depth as a belt-and-suspenders against a pathological
    // rescan-storm livelock — at depth > 4 we just return whatever core we
    // have (even if "stale" by TTL), since the queued rescan will eventually
    // catch up on the next caller.
    if (depth > 4) {
      if (_httpCore) return _httpCore.core;
      throw new Error("ensureCoreFresh exceeded recursion depth without producing a core");
    }
    return ensureCoreFresh(forceFullRescan || _pendingFullRescan, depth + 1);
  }

  const wantFullRescan = forceFullRescan || _pendingFullRescan;
  _pendingFullRescan = false;

  _httpCorePromise = (async () => {
    try {
      if (_httpCore && !wantFullRescan) {
        // Warm + stale → cheap incremental today refresh. `refreshToday()`
        // re-reads ONLY today's active files and splices onto frozen history,
        // which is never touched (immutability rule).
        await _httpCore.core.refreshToday();
        _httpCore.ts = Date.now();
        return _httpCore.core;
      }
      if (_httpCore) {
        // Warm + full rescan (e.g. after `/api/update-pricing`). Core's own
        // immutability rules keep frozen history frozen; only today reprices.
        await _httpCore.core.scan();
        _httpCore.ts = Date.now();
        return _httpCore.core;
      }
      // Cold start: build the ONE persistent core and load frozen history once.
      const { TokmeterCore } = await import("@sriinnu/tokmeter");
      const core = new TokmeterCore();
      await core.scan();
      _httpCore = { core, ts: Date.now() };
      _httpCoreReady = true;
      return core;
    } finally {
      // Promise tracking ends here regardless of success/failure — the next
      // caller starts a fresh attempt. `_httpCoreReady` is NOT flipped here
      // because we want it to reflect "have we ever produced a warm core",
      // not "did the last attempt succeed".
      _httpCorePromise = null;
    }
  })();

  return _httpCorePromise;
}

async function getHttpCore(): Promise<any> {
  return ensureCoreFresh(false);
}

/**
 * Force a full re-scan of the persistent core (history reloaded, today
 * repriced). Used after a pricing update. Routes through the single mediator
 * so concurrent calls and concurrent refreshes don't stack into back-to-back
 * full-corpus scans.
 */
async function rescanHttpCore(): Promise<void> {
  await ensureCoreFresh(true);
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
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
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

    // DNS-rebinding guard: reject any request whose Host is not localhost.
    // Applies to GET reads too (they carry spend/history), which the CORS
    // header alone does not protect once a rebound origin is same-origin.
    if (!isAllowedHttpHost(req.headers.host)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Forbidden host" }));
      return;
    }

    const url = req.url ?? "/";
    // Path without query so endpoints that accept `?providers=` (used by the
    // CLI's daemon-read fast path for `stats/daily/models --json --codex`) still
    // route correctly. Endpoints without params can keep matching `url`.
    const pathname = url.split("?")[0];

    try {
      const { CleanupService } = await import("@sriinnu/tokmeter");

      // GET endpoints — all routing keys off `pathname` (i.e. URL minus query
      // string) so a stray `?foo=bar` on a parameterless endpoint can never
      // bypass the route into the 404 default. Endpoints that accept query
      // params parse them off `url` explicitly.
      if (req.method === "GET") {
        // Fast endpoints — never trigger a fresh scan, just report state.
        // /api/ready is a tiny health check the menubar uses to know whether
        // it's worth firing the slow endpoints yet.
        if (pathname === "/api/ready") {
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
        if (pathname === "/api/quick") {
          // Live context-window fill (worst session across all providers that
          // report one) rides the fast endpoint so the menubar color can track
          // it near-real-time. Undefined when no live session exposes it — the
          // bar then colors by the universal cost/budget signal.
          const liveContextFillPct = sessionManager?.getAggregated().maxContextFillPct;
          if (_httpCore) {
            const stats = applyStatsFloor(_httpCore.core.getStats());
            // getStatbarSignals() is cheap here — it walks only the bounded
            // in-memory recentRecords window, not the corpus — so the 5-hour
            // billing-block % can ride this same fast endpoint, same as
            // liveContextFillPct above. This is also what makes the ".block"
            // menubar color source a live daemon round-trip instead of a
            // static value: a failed/offline fetch clears it to undefined
            // rather than showing a stale reading.
            const blockElapsedPct = _httpCore.core.getStatbarSignals().billingWindow?.elapsedPct;
            json(res, { ready: true, stats, liveContextFillPct, blockElapsedPct });
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
              liveContextFillPct,
            });
          }
          return;
        }

        // Slow endpoints — wait for the core to be ready.
        if (pathname === "/api/summary") {
          const { summary, source } = await getHttpSummaryPayload();
          res.setHeader(SUMMARY_SOURCE_HEADER, source);
          json(res, summary);
          return;
        }

        const core = await getHttpCore();

        if (pathname === "/api/today") {
          // Today's cross-provider totals, computed from the WARM core — no
          // scan. The statusline reads this so it NEVER scans on its 200ms hot
          // path. Shape matches statusline's TodayTotals. The today-floor pins
          // each field to its per-day high-water mark so codex fork-dedup
          // swaps can't show today *decreasing* (user can't un-spend money).
          json(res, applyTodayFloor(computeTodayTotals(core)));
        } else if (pathname === "/api/projects") {
          json(res, core.getAllProjects());
        } else if (pathname === "/api/sessions") {
          // All projects across providers, sorted by most-recently-used descending.
          // Used by the menubar's expandable session list — supports 10/20/50+ items.
          const projects = core
            .getAllProjects()
            .slice()
            .sort((a: { lastUsed: number }, b: { lastUsed: number }) => b.lastUsed - a.lastUsed);
          json(res, projects.slice(0, 50));
        } else if (pathname.startsWith("/api/projects/")) {
          const name = decodeURIComponent(pathname.slice("/api/projects/".length));
          json(res, core.getProjectSummary(name) ?? { error: "Not found" });
        } else if (pathname === "/api/stats") {
          const providers = parseProviders(url);
          if (providers) {
            // Provider-filtered stats: NOT floored. The floor is a
            // display-stability guard for the BAR's lifetime hero, which
            // reads unfiltered /api/stats. A provider-scoped read is a
            // different number and shouldn't inherit the lifetime floor.
            json(res, core.getStats({ providers }));
          } else {
            // Lifetime stats — floored so the bar's hero stays monotonic
            // within the day. See applyStatsFloor for the why.
            json(res, applyStatsFloor(core.getStats()));
          }
        } else if (pathname === "/api/statbar-signals") {
          // Live "right now" signals for the menubar — burn rate, cache hit,
          // pace vs typical, compaction tax, and the live session pointer.
          // Cheap to compute (single pass over records), so polled on the
          // same 30s cadence as everything else.
          json(res, core.getStatbarSignals());
        } else if (pathname === "/api/models") {
          const providers = parseProviders(url);
          json(res, core.getModelCosts(providers ? { providers } : undefined));
        } else if (pathname === "/api/health") {
          // Surface silent-pricing leaks: today-records that priced at $0
          // because no tier (kosha runtime, manifest, override) had pricing.
          // The bar UI uses unpricedModels.length to flip to amber state.
          //
          // Cap the array at 100 entries to defend against a pathological
          // parser bug that could emit thousands of distinct fake model IDs;
          // the bar only needs the count + a sample to render the warning.
          const meta = core.getScanMeta();
          const UNPRICED_CAP = 100;
          const allUnpriced = meta.unpricedModels;
          json(res, {
            ready: true,
            unpricedModels: allUnpriced.slice(0, UNPRICED_CAP),
            unpricedModelsTotal: allUnpriced.length,
            unpricedModelsTruncated: allUnpriced.length > UNPRICED_CAP,
            unpricedRecords: meta.unpricedRecords,
            warnings: meta.warnings,
            lastScanAt: meta.lastScanAt,
          });
        } else if (pathname === "/api/today-models") {
          json(res, core.getModelCosts({ today: true }));
        } else if (pathname === "/api/cross-tool") {
          // Project today's token shape against the user's top lifetime
          // models. Surfaces "what would today have cost on model X" — the
          // kind of comparison only kosha-backed tools can ship honestly.
          json(res, await core.getCrossToolComparison());
        } else if (pathname === "/api/pricing-status") {
          // Reports the mtime of ~/.kosha/registry.json so the menubar can
          // surface "Pricing: 2h ago". 0 if the registry is missing.
          let mtime = 0;
          try {
            const { statSync } = await import("node:fs");
            const { join } = await import("node:path");
            const { homedir } = await import("node:os");
            mtime = statSync(join(homedir(), ".kosha", "registry.json")).mtimeMs;
          } catch {}
          json(res, { registryMtime: mtime });
        } else if (pathname === "/api/anomalies") {
          // Pricing anomalies kosha logs at merge time. Read-only window:
          // last 24h of >25% rate movements. Caps the response so a
          // pathological diff burst (provider migration day) doesn't ship
          // megabytes through the bar's 30s poll.
          const ANOM_CAP = 50;
          const TWENTY_FOUR_H = 24 * 3600 * 1000;
          let recent: unknown[] = [];
          let total = 0;
          try {
            const { readFileSync } = await import("node:fs");
            const { join: pjoin } = await import("node:path");
            const { homedir: hd } = await import("node:os");
            const path = pjoin(hd(), ".kosha", "anomalies.json");
            const parsed = JSON.parse(readFileSync(path, "utf-8")) as {
              anomalies?: Array<{ ts: number }>;
            };
            const cutoff = Date.now() - TWENTY_FOUR_H;
            const all = (parsed.anomalies ?? []).filter((a) => a.ts >= cutoff);
            total = all.length;
            recent = all.slice(-ANOM_CAP).reverse(); // newest first
          } catch {}
          json(res, { anomalies: recent, total, cappedAt: ANOM_CAP });
        } else if (pathname === "/api/cron-status") {
          // Report whether the daily kosha-refresh launchd job is installed
          // and the result of its last run. The plist truncates the log on
          // every run, so the entire file contents represent the last run
          // only — the success/failure substring scan is unambiguous. We
          // bound the read to 8KB as a defense against runaway logs and
          // open with O_NOFOLLOW so a hostile symlink at logPath can't
          // exfiltrate arbitrary user-readable files via this endpoint.
          const fs = await import("node:fs");
          const { existsSync, openSync, readSync, closeSync, fstatSync } = fs;
          const { join } = await import("node:path");
          const { homedir } = await import("node:os");
          const home = homedir();
          const plistPath = join(
            home,
            "Library",
            "LaunchAgents",
            "com.sriinnu.tokmeter.daily.plist"
          );
          const logPath = join(home, ".cache", "tokmeter", "daily-cron.log");
          let installed = false;
          let lastRunMtime = 0;
          let lastRunOk: boolean | null = null;
          let lastRunTail = "";
          try {
            installed = existsSync(plistPath);
          } catch {}
          try {
            const fd = openSync(logPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
            try {
              // fstat the open fd, not the path — eliminates the TOCTOU window
              // between path-stat and path-open.
              const stat = fstatSync(fd);
              lastRunMtime = stat.mtimeMs;
              const cap = 8192;
              const offset = Math.max(0, stat.size - cap);
              const buf = Buffer.alloc(Math.min(cap, stat.size));
              if (buf.length > 0) {
                readSync(fd, buf, 0, buf.length, offset);
              }
              const data = buf.toString("utf8");
              const lines = data.trim().split("\n");
              lastRunTail = lines.slice(-3).join("\n");
              // The CLI emits "Kosha registry refreshed." on success and
              // "Failed to refresh kosha:" on error. Anything else → unknown.
              if (data.includes("Kosha registry refreshed")) lastRunOk = true;
              else if (data.includes("Failed to refresh kosha")) lastRunOk = false;
            } finally {
              closeSync(fd);
            }
          } catch {
            // ENOENT (no log yet) and ELOOP (symlink — refused) both fall
            // through to defaults. Fail closed.
          }
          json(res, { installed, lastRunMtime, lastRunOk, lastRunTail });
        } else if (pathname === "/api/daily") {
          const providers = parseProviders(url);
          if (providers) {
            json(res, core.getDailyBreakdown({ providers }));
          } else {
            // Floor today's last entry to the per-day high-water so the macOS
            // bar's hero (which reads daily.last.cost) is monotonic upward —
            // codex fork-dedup winner swaps can't make today's display drop.
            const daily = core.getDailyBreakdown() as Array<{
              date: string;
              cost: number;
              totalTokens: number;
              [k: string]: unknown;
            }>;
            const todayKey = localDateKey();
            const floored = applyTodayFloor(computeTodayTotals(core));
            if (daily.length > 0 && daily[daily.length - 1]?.date === todayKey) {
              const last = daily[daily.length - 1];
              if (floored.cost > last.cost) last.cost = floored.cost;
              const flooredTokens = floored.in + floored.out;
              if (flooredTokens > last.totalTokens) last.totalTokens = flooredTokens;
            }
            json(res, daily);
          }
        } else if (pathname === "/api/providers") {
          json(res, core.getProviderBreakdown());
        } else if (pathname === "/api/antigravity-live") {
          // Cache-only read — never triggers a poll. The background
          // interval (see startDaemon) is the only thing that ever hits
          // Antigravity's process/network; readers just see what it's
          // already captured, or null if Antigravity has never answered.
          const { computeCreditsUsedToday, readLatestAntigravitySnapshot } = await import(
            "@sriinnu/tokmeter"
          );
          json(res, {
            latestSnapshot: readLatestAntigravitySnapshot(),
            creditsUsedToday: computeCreditsUsedToday(),
          });
        } else if (pathname === "/api/backups") {
          const service = new CleanupService(core);
          json(res, service.listBackups());
        } else if (pathname === "/api/themes") {
          const { listThemes } = await import("@sriinnu/tokmeter");
          json(res, listThemes());
        } else {
          res.writeHead(404);
          json(res, {
            error: "Not found",
            endpoints: [
              "/api/ready",
              "/api/quick",
              "/api/today",
              "/api/summary",
              "/api/projects",
              "/api/sessions",
              "/api/stats",
              "/api/statbar-signals",
              "/api/models",
              "/api/daily",
              "/api/providers",
              "/api/antigravity-live",
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
          // Do NOT echo the token file path here — it's an info leak that
          // tells an unauthenticated probe exactly where the secret lives.
          // Legit clients already know the path from the daemon's own
          // startup log (visible only to the owning user).
          json(res, { error: "Unauthorized" });
          return;
        }
        const body = await readBody(req);

        if (pathname === "/api/cleanup/preview") {
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
        } else if (pathname === "/api/cleanup/execute") {
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
          invalidateHttpCore(); // Cache + floors must follow the mutation.
          json(res, result);
        } else if (pathname === "/api/restore") {
          if (body.confirm !== "RESTORE") {
            res.writeHead(403);
            json(res, { error: "confirm must be 'RESTORE'" });
            return;
          }
          const { TokmeterCore } = await import("@sriinnu/tokmeter");
          const core = new TokmeterCore({ skipPricing: true });
          const service = new CleanupService(core);
          const result = service.restore(body.backup_id);
          invalidateHttpCore(); // Cache + floors must follow the mutation.
          json(res, result);
        } else if (pathname === "/api/update-pricing") {
          // Mutation (network fetch + full rescan), so token-gated under POST —
          // a GET here let any visited web page force repeated multi-GB rescans
          // cross-origin (CSRF / resource-exhaustion DoS).
          try {
            await refreshKoshaRegistry();
            // Pricing changed → today must reprice. Full re-scan of the warm
            // singleton (history stays frozen per the core's rules) keeps the
            // daemon warm and bounded instead of paying a cold start next read.
            await rescanHttpCore();
            json(res, { ok: true });
          } catch (err) {
            res.writeHead(500);
            json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else if (pathname === "/api/rescan") {
          // DEEP rescan — the ONE explicit path that re-reads RAW history. It is
          // WINDOWED, not full-history: it re-derives only the last
          // DEEP_RESCAN_WINDOW_DAYS sealed days and overwrites just those files.
          // That's exactly what's needed — backfill pace's costByHour (which only
          // reads the last few days) and correct any recently mis-sealed day —
          // without the multi-GB full-corpus parse that once drove the machine to
          // an OOM reboot. Older days' curves are never read, so re-deriving them
          // is pure waste. Token-gated POST (CSRF/DoS, like update-pricing) and
          // FIRE-AND-FORGET: returns immediately, rebuilds in the background.
          try {
            // Memory guard: even windowed + streamed, the rebuild is the heaviest
            // thing the daemon does. Refuse unless there's real headroom — the
            // fast path keeps serving; the user frees RAM and retries. This is
            // the guard that was missing when a rescan stacked on a 16 GB local
            // LLM and Jetsam-rebooted the box.
            //
            // On macOS the signal must be the kernel's memory-pressure level,
            // NOT os.freemem(): freemem maps to truly-free pages only, which
            // sit near zero on any warm Mac (inactive/purgeable pages are
            // reclaimed on demand), so a GB threshold blocks every rescan on
            // a machine that's actually fine (observed: 0.3 GB "free" at 68%
            // real availability on a 38 GB box). Pressure levels: 1 = normal,
            // 2 = warning, 4 = critical.
            let memRefusal: string | null = null;
            if (process.platform === "darwin") {
              try {
                const { execFileSync } = await import("node:child_process");
                const level = Number(
                  execFileSync("/usr/sbin/sysctl", ["-n", "kern.memorystatus_vm_pressure_level"], {
                    timeout: 2000,
                  })
                    .toString()
                    .trim()
                );
                if (Number.isFinite(level) && level > 1) {
                  memRefusal = `Memory pressure is ${level === 2 ? "warning" : "critical"} — close memory-heavy apps (e.g. a local LLM) and retry.`;
                }
              } catch {
                // Can't read the pressure level — don't block an explicit,
                // user-initiated action on a missing metric.
              }
            } else {
              const os = await import("node:os");
              const freeGb = os.freemem() / 1_073_741_824;
              const NEED_FREE_GB = 6;
              if (freeGb < NEED_FREE_GB) {
                memRefusal = `Low memory: ${freeGb.toFixed(1)} GB free, need ~${NEED_FREE_GB} GB to rebuild safely. Close memory-heavy apps (e.g. a local LLM) and retry.`;
              }
            }
            if (memRefusal) {
              res.writeHead(503);
              json(res, { ok: false, error: memRefusal });
              return;
            }
            const core = await getHttpCore();
            if (_rescanInFlight) {
              json(res, { ok: true, started: false, alreadyRunning: true });
            } else {
              _rescanInFlight = true;
              void core
                .rebuildRecentDays(DEEP_RESCAN_WINDOW_DAYS)
                .then(() => {
                  _httpCore = { core, ts: Date.now() };
                })
                .catch((e: unknown) => {
                  console.error(`deep rescan failed: ${e instanceof Error ? e.message : e}`);
                })
                .finally(() => {
                  _rescanInFlight = false;
                });
              json(res, { ok: true, started: true });
            }
          } catch (err) {
            res.writeHead(500);
            json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else if (pathname === "/api/antigravity-live/fetch") {
          // The one-shot manual counterpart to the (opt-in, default-off)
          // background poll interval: fetches once, right now, and returns
          // the result inline instead of waiting for the next tick. Still
          // does the same credential-read + undocumented-RPC call the
          // background job does, just for a single explicit invocation
          // instead of running unsupervised forever — but a website could
          // CSRF a GET here just as easily as it could CSRF /api/rescan, so
          // this is POST + token-gated for the same reason those are.
          try {
            const snapshot = await pollAntigravityLiveStatus();
            json(res, { ok: true, snapshot });
          } catch (err) {
            res.writeHead(500);
            json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else {
          res.writeHead(404);
          json(res, { error: "Not found" });
        }
        return;
      }

      res.writeHead(405);
      json(res, { error: "Method not allowed" });
    } catch (err) {
      // Log the real cause — a silent 500 here is exactly what made the
      // daemon's read endpoints look "broken" with no way to diagnose. We
      // log `.message` only (NOT `.stack`) — stack traces contain absolute
      // paths and internal file structure that's an info leak when daemon
      // logs end up in a shared location (e.g. `/tmp/d_b.log` during dev,
      // launchd logs, screenshots in support tickets). Daemon authors who
      // need a stack trace can attach a debugger or set TOKMETER_DAEMON_DEBUG.
      const msg = err instanceof Error ? err.message : String(err);
      if (process.env.TOKMETER_DAEMON_DEBUG === "1" && err instanceof Error) {
        console.error(`HTTP request failed [${req.url}]:`, err.stack);
      } else {
        console.error(`HTTP request failed [${req.url}]: ${msg}`);
      }
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

export interface TodayTotals {
  cost: number;
  in: number;
  out: number;
  projects: Record<string, { cost: number; in: number; out: number }>;
  day: string;
}

/**
 * Compute today's cross-provider totals from the warm core's loaded records.
 * Cheap — a single filtered pass, no disk scan. Shape MUST stay in lockstep
 * with the statusline's TodayTotals consumer in src/statusline.ts.
 */
/**
 * Parse a `?providers=codex,claude-code` (or `?provider=codex`) filter off a
 * request URL. Returns null when absent. Lets read endpoints serve a
 * provider-scoped view from the warm core — so the CLI's `--codex` flag maps to
 * a cheap filtered read instead of a fresh provider-scoped scan.
 */
/**
 * Defensive caps:
 *   - MAX_PROVIDERS: hard upper bound on list length so a pathological URL
 *     `?providers=a,a,a,...` (10MB worth) can't get fanned into a giant array
 *     and a quadratic filter scan.
 *   - MAX_PROVIDER_LEN: per-id length cap — provider IDs are short slugs
 *     (`codex`, `claude-code`, ...). Anything over this is junk input.
 *   - PROVIDER_PATTERN: alphanumeric + hyphen only. Rejects `?providers=../../`
 *     style probes, control chars, and Unicode shenanigans before they reach
 *     the filter layer.
 */
const MAX_PROVIDERS = 32;
const MAX_PROVIDER_LEN = 64;
const PROVIDER_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function parseProviders(url: string): ProviderId[] | null {
  const qi = url.indexOf("?");
  if (qi < 0) return null;
  const params = new URLSearchParams(url.slice(qi + 1));
  const raw = params.get("providers") ?? params.get("provider");
  if (!raw) return null;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s || s.length > MAX_PROVIDER_LEN) continue;
    if (!PROVIDER_PATTERN.test(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    list.push(s);
    if (list.length >= MAX_PROVIDERS) break;
  }
  return list.length > 0 ? (list as ProviderId[]) : null;
}

/**
 * Per-day high-water marks for "today" — today's cost MUST be monotonic
 * upward within a day (you cannot un-spend money), but the codex parser's
 * fork-dedup ("latest mtime sibling wins") can swap winners as new sibling
 * rollouts appear, momentarily showing a SMALLER today total than the prior
 * scan. That's parser flux, not a real refund. The floor pins each field to
 * the high-water mark observed during the current local day so the displayed
 * "today" only ever grows. Resets automatically on day rollover (when
 * `localDateKey()` changes). Note: the underlying records and the
 * non-today endpoints are unaffected — this is a display-stability guard
 * scoped to /api/today only.
 */
let _todayHighWater: TodayTotals | null = null;

/**
 * Lifetime-cost high-water for /api/stats and /api/quick. Same rationale as
 * `_todayHighWater`: lifetime = frozen history + today, frozen history is
 * immutable, so the only thing that can move lifetime is today — and today
 * must be monotonic upward within the day. Reset on day rollover (tracked
 * by `localDateKey()`) so a new day's totals can climb fresh.
 *
 * Why a separate floor from today's: the bar's lifetime hero reads
 * `stats.totalCost`, not `today.cost`. They live on different endpoints and
 * a parser swap that nudges today by $0.10 nudges lifetime by the same
 * $0.10 — both displays would flicker if we only floored one.
 */
export interface StatsFloor {
  day: string;
  totalCost: number;
  totalTokens: number;
}
let _statsHighWater: StatsFloor | null = null;

/**
 * Pure high-water merge, split out from {@link applyTodayFloor} so the
 * monotonicity math is testable without the module-level `_todayHighWater`
 * singleton. `prior === null` (or a stale day) resets the floor to `computed`
 * as-is; otherwise every field — including each project's own cost/in/out —
 * is pinned to its own running max.
 */
export function computeTodayFloor(computed: TodayTotals, prior: TodayTotals | null): TodayTotals {
  // Day rollover (or first call) — reset the floor and accept what we see.
  if (!prior || prior.day !== computed.day) {
    return {
      cost: computed.cost,
      in: computed.in,
      out: computed.out,
      day: computed.day,
      projects: { ...computed.projects },
    };
  }

  const dropped = computed.cost + 0.005 < prior.cost;
  if (dropped) {
    // Surface the suppression so it's not invisible — small per-scan dips are
    // usually codex fork-dedup winner swaps and we DELIBERATELY keep the
    // high-water. Logged at console.warn for daemon stderr only.
    console.warn(
      `[today-floor] computed today $${computed.cost.toFixed(2)} < high-water $${prior.cost.toFixed(2)} — keeping high-water (likely codex fork-dedup winner swap; data not lost, just a parser-side reweighting).`
    );
  }

  // Take per-field max (cost/in/out and per-project) so each number is
  // pinned to its own monotone-upward floor. Build a NEW snapshot rather
  // than mutating either side so callers can't see partial state.
  const allKeys = new Set([...Object.keys(computed.projects), ...Object.keys(prior.projects)]);
  const projects: Record<string, { cost: number; in: number; out: number }> = {};
  for (const k of allKeys) {
    const a = computed.projects[k] ?? { cost: 0, in: 0, out: 0 };
    const b = prior.projects[k] ?? { cost: 0, in: 0, out: 0 };
    projects[k] = {
      cost: Math.max(a.cost, b.cost),
      in: Math.max(a.in, b.in),
      out: Math.max(a.out, b.out),
    };
  }

  return {
    cost: Math.max(computed.cost, prior.cost),
    in: Math.max(computed.in, prior.in),
    out: Math.max(computed.out, prior.out),
    day: computed.day,
    projects,
  };
}

function applyTodayFloor(computed: TodayTotals): TodayTotals {
  _todayHighWater = computeTodayFloor(computed, _todayHighWater);
  return _todayHighWater;
}

/**
 * Pin lifetime `totalCost` and `totalTokens` to a within-day high-water mark.
 * Other fields (counts, streaks, firstUsed/lastUsed) pass through unchanged —
 * they aren't subject to the same parser-flux drop pattern that motivates the
 * today-floor. If the input shape doesn't look like the stats object we expect
 * (e.g. a future signature change), we pass through unmodified.
 */
/**
 * Pure high-water merge, split out from {@link applyStatsFloor} so it's
 * testable without the module-level `_statsHighWater` singleton or the real
 * current date — `day` is an explicit parameter instead of `localDateKey()`.
 * `prior === null` means "no data at all yet" (not a code path {@link
 * applyStatsFloor} can hit, since it always seeds a floor on first call, but
 * kept for a clean pure-function signature) and passes `stats` through
 * unfloored with no floor recorded.
 */
export function computeStatsFloor<T extends { totalCost?: number; totalTokens?: number }>(
  stats: T,
  prior: StatsFloor | null,
  day: string
): { result: T; floor: StatsFloor | null } {
  if (!stats || typeof stats.totalCost !== "number" || typeof stats.totalTokens !== "number") {
    return { result: stats, floor: prior };
  }
  if (!prior || prior.day !== day) {
    return {
      result: stats,
      floor: { day, totalCost: stats.totalCost, totalTokens: stats.totalTokens },
    };
  }
  if (stats.totalCost + 0.005 < prior.totalCost) {
    console.warn(
      `[stats-floor] lifetime $${stats.totalCost.toFixed(2)} < high-water $${prior.totalCost.toFixed(2)} — keeping high-water (matches today-floor; almost certainly a codex fork-dedup winner swap).`
    );
  }
  const totalCost = Math.max(stats.totalCost, prior.totalCost);
  const totalTokens = Math.max(stats.totalTokens, prior.totalTokens);
  return { result: { ...stats, totalCost, totalTokens }, floor: { day, totalCost, totalTokens } };
}

function applyStatsFloor<T extends { totalCost?: number; totalTokens?: number }>(stats: T): T {
  const { result, floor } = computeStatsFloor(stats, _statsHighWater, localDateKey());
  _statsHighWater = floor;
  return result;
}

function computeTodayTotals(core: any): TodayTotals {
  const day = localDateKey();
  const today = core.getTodayAggregate?.() as {
    cost: number;
    inputTokens: number;
    outputTokens: number;
    projects: Record<string, { cost: number; inputTokens: number; outputTokens: number }>;
  } | null;
  const projects: Record<string, { cost: number; in: number; out: number }> = {};
  if (today) {
    for (const [name, pb] of Object.entries(today.projects)) {
      projects[name || "unknown"] = {
        cost: pb.cost,
        in: pb.inputTokens,
        out: pb.outputTokens,
      };
    }
    return { cost: today.cost, in: today.inputTokens, out: today.outputTokens, projects, day };
  }
  return { cost: 0, in: 0, out: 0, projects, day };
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

      // If launchd is actively managing the daemon, don't fork our own
      // detached child (it would race the agent's copy on port 9876). Ask
      // launchd to start it. We gate on isAgentLoaded() (actually bootstrapped)
      // rather than isAgentInstalled() (plist merely on disk) so a plist that
      // exists but isn't loaded falls through to the normal fork path below
      // instead of stranding the user offline on a kickstart that errors.
      // The DAEMON_CHILD_FLAG guard lets launchd's OWN `daemon start` fall
      // through to the foreground path below.
      if (process.env[DAEMON_CHILD_FLAG] !== "1" && isAgentLoaded()) {
        try {
          kickstartAgent();
          await new Promise((r) => setTimeout(r, 800));
          console.log("【♾️】 Drishti Daemon started via launchd");
          console.log(getDaemonStatus());
          break;
        } catch (err) {
          // Fall through to the manual fork path rather than leave it down.
          console.log(`launchd kickstart failed (${err}); starting manually instead`);
        }
      }

      // If we ARE the detached child (or launchd's foreground process), run
      // the daemon in the foreground.
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
        // Cap the daemon's heap so even a runaway scan can't balloon the box
        // back into kernel-panic territory. Threaded via NODE_OPTIONS so it
        // applies whether the child is launched directly or re-execs.
        const child = spawn(process.execPath, [process.argv[1], "daemon", "start"], {
          detached: true,
          stdio: "ignore",
          env: {
            ...process.env,
            [DAEMON_CHILD_FLAG]: "1",
            NODE_OPTIONS:
              `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${DAEMON_HEAP_CAP_MB}`.trim(),
          },
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
      // Under launchd, a plain SIGTERM is futile — the agent respawns it on
      // abnormal exit. Bail with the real instruction instead of looking like
      // the stop failed. Gate on isAgentLoaded() (actually managing it), not a
      // stale plist on disk.
      if (isAgentLoaded()) {
        console.log(
          "Daemon is launchd-supervised — stopping it directly won't stick.\n" +
            "    To stop it, run: drishti daemon uninstall-agent"
        );
        break;
      }
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
      // launchd-managed: a single kickstart -k kills + restarts atomically,
      // and avoids a SIGTERM the agent would just respawn anyway. Gate on
      // loaded, and fall through to the manual path if the kickstart errors.
      if (isAgentLoaded()) {
        try {
          kickstartAgent();
          await new Promise((r) => setTimeout(r, 800));
          console.log("【♾️】 Drishti Daemon restarted via launchd");
          console.log(getDaemonStatus());
          break;
        } catch (err) {
          console.log(`launchd kickstart failed (${err}); restarting manually instead`);
        }
      }
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

    case "install-agent": {
      if (process.platform !== "darwin") {
        console.log("launchd supervision is macOS-only; on this platform use `daemon start`.");
        break;
      }
      // Stop any manually-spawned daemon first so launchd's RunAtLoad copy
      // doesn't race it on the port.
      if (isDaemonRunning()) {
        const { pid } = getDaemonStatus();
        if (pid) {
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
          let retries = 10;
          while (retries > 0 && isDaemonRunning()) {
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
            retries--;
          }
        }
      }
      // If it's STILL alive, bootstrapping now would just collide on the port
      // (the launchd copy bows out on EADDRINUSE). Abort cleanly instead of
      // installing into a guaranteed race.
      if (isDaemonRunning()) {
        console.log(
          "A daemon is still running and wouldn't release port. Aborting install.\n" +
            "    Stop it (drishti daemon stop) and retry install-agent."
        );
        break;
      }
      try {
        const { plistPath, heapEnforced } = installAgent();
        console.log(`【♾️】 launchd agent installed: ${plistPath}`);
        console.log("    Respawns on crash, OOM, and login (clean exits stay down).");
        if (!heapEnforced) {
          console.log(
            "    ⚠ heap cap NOT enforced — the agent launches via bun, which ignores\n" +
              "      NODE_OPTIONS --max-old-space-size. Build the dist (bun run build) so a\n" +
              "      node+dist entry is available, or set TOKMETER_DAEMON_HEAP_MB awareness."
          );
        }
        await new Promise((r) => setTimeout(r, 1000));
        console.log(getDaemonStatus());
      } catch (err) {
        console.log(`Failed to install launchd agent: ${err}`);
      }
      break;
    }

    case "uninstall-agent": {
      if (!isAgentInstalled()) {
        console.log("No launchd agent installed.");
        break;
      }
      try {
        uninstallAgent();
        console.log(`Removed launchd agent (${AGENT_LABEL}) and plist at ${agentPlistPath()}`);
        console.log("    The daemon is no longer supervised. Use `daemon start` to run it.");
      } catch (err) {
        console.log(`Failed to remove launchd agent: ${err}`);
      }
      break;
    }

    default:
      console.log(
        "Usage: drishti daemon [start|stop|status|restart|install-agent|uninstall-agent]"
      );
  }
}
