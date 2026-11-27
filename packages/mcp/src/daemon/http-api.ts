/**
 * Daemon HTTP REST API, bearer-token auth, warm TokmeterCore lifecycle, and test server factory.
 */

import { readdirSync, statSync } from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  localDateKey,
  pollAntigravityLiveStatus,
  type QuotaWindow,
  refreshKoshaRegistry,
  TokmeterCore,
  type TokmeterSummary,
} from "@sriinnu/tokmeter";
import { API_HEADER, apiVersionHeaders, LEGACY_API_HEADER } from "./compat-names.js";
import { applyStatsFloor, applyTodayFloor, computeTodayTotals } from "./floors.js";
import { checkAuth, isAllowedHttpHost, isValidAuthHeader } from "./http-auth.js";
import { DAEMON_HOST, DAEMON_PORT, DAEMON_TOKEN_FILE, type DaemonEventKind } from "./protocol.js";
import { RefreshCoordinator } from "./refresh-coordinator.js";
import {
  appendSummaryWarnings,
  executeScopedRoute,
  parseDaemonScopeQuery,
  SUMMARY_SOURCE_HEADER,
  toErrorMessage,
} from "./scoped-routes.js";
import type { Session, SessionManager } from "./session.js";
import {
  buildBarSnapshot,
  buildStatuslineContext,
  getCachedQuota,
  readAnomaliesPayload,
  readAntigravityLivePayload,
  readCronStatusPayload,
  readDailyFloored,
  readHealthPayload,
  readPricingStatusPayload,
  readSessionsPayload,
  sessionLedgerForTranscript,
} from "./snapshots.js";

export const HTTP_PORT = DAEMON_PORT + 1;
const API_VERSION = 1;
const TODAY_REFRESH_TTL = 12_000;
const REFRESH_FAILURE_BACKOFF_MS = 15_000;
const DEEP_RESCAN_WINDOW_DAYS = 30;

export interface HttpCoreEntry {
  core: TokmeterCore;
  ts: number;
  lastScanDurationMs: number;
  hydratedOnly: boolean;
}

export type DaemonEventListener = (
  event: DaemonEventKind,
  computedAt: number,
  localDate: string
) => void;

let httpServer: ReturnType<typeof createHttpServer> | null = null;
let _httpCore: HttpCoreEntry | null = null;
let _httpCoreReady = false;
let _hasCompletedLiveScan = false;
let _rescanInFlight = false;
let _onCoreEvent: DaemonEventListener | null = null;
let _lastCompletedLocalDate: string | null = null;
let _lastRefreshFailure: { at: number; message: string } | null = null;

function emitCoreEvent(event: DaemonEventKind, computedAt: number): void {
  _onCoreEvent?.(event, computedAt, localDateKey(computedAt));
}

function computeHydratedTimestamp(homeDir: string): number {
  const todayFile = join(homeDir, ".cache", "tokmeter", "today", `${localDateKey()}.json`);
  try {
    const mtime = statSync(todayFile).mtimeMs;
    if (Number.isFinite(mtime) && mtime > 0) return mtime;
  } catch {
    /* ignore */
  }
  const aggDir = join(homeDir, ".cache", "tokmeter", "aggregates");
  try {
    let newest = 0;
    for (const entry of readdirSync(aggDir)) {
      if (!entry.endsWith(".json")) continue;
      try {
        const mtime = statSync(join(aggDir, entry)).mtimeMs;
        if (Number.isFinite(mtime) && mtime > newest) newest = mtime;
      } catch {
        /* ignore */
      }
    }
    if (newest > 0) return newest;
  } catch {
    /* ignore */
  }
  return Date.now();
}

function isCoreStale(entry: HttpCoreEntry, now = Date.now()): boolean {
  if (entry.hydratedOnly) return true;
  if (localDateKey(entry.ts) !== localDateKey(now)) return true;
  return now - entry.ts >= TODAY_REFRESH_TTL;
}

function safeComputedAt(): number {
  return _httpCore && _httpCore.ts > 0 ? _httpCore.ts : Date.now();
}

function isLiveScanned(): boolean {
  return Boolean(_httpCore && !_httpCore.hydratedOnly);
}

const coreRefresh = new RefreshCoordinator<TokmeterCore>(async (full) => {
  const wasLiveScanned = _hasCompletedLiveScan;
  const startedAt = Date.now();
  try {
    let core: TokmeterCore;
    if (_httpCore) {
      if (full) await _httpCore.core.scan();
      else await _httpCore.core.refreshToday();
      core = _httpCore.core;
    } else {
      core = new TokmeterCore();
      await core.scan();
    }
    const finishedAt = Date.now();
    const todayKey = localDateKey(finishedAt);
    _httpCore = {
      core,
      ts: finishedAt,
      lastScanDurationMs: finishedAt - startedAt,
      hydratedOnly: false,
    };
    _httpCoreReady = true;
    _hasCompletedLiveScan = true;
    _lastRefreshFailure = null;
    if (!wasLiveScanned) {
      emitCoreEvent("core_warmed", finishedAt);
    } else if (_lastCompletedLocalDate && _lastCompletedLocalDate !== todayKey) {
      emitCoreEvent("day_rolled_over", finishedAt);
    } else {
      emitCoreEvent("refresh_completed", finishedAt);
    }
    _lastCompletedLocalDate = todayKey;
    return core;
  } catch (err) {
    _lastRefreshFailure = { at: Date.now(), message: toErrorMessage(err) };
    throw err;
  }
});

async function ensureCoreFresh(forceFullRescan = false): Promise<TokmeterCore> {
  if (!forceFullRescan && !coreRefresh.busy && _httpCore && !isCoreStale(_httpCore)) {
    return _httpCore.core;
  }
  return coreRefresh.run(forceFullRescan);
}

async function getHttpCore(): Promise<TokmeterCore> {
  return ensureCoreFresh(false);
}

async function getHttpCoreNoWait(): Promise<TokmeterCore> {
  if (!_httpCore) return getHttpCore();
  const now = Date.now();
  if (_lastRefreshFailure && now - _lastRefreshFailure.at < REFRESH_FAILURE_BACKOFF_MS) {
    return _httpCore.core;
  }
  const effectiveAge =
    _httpCore.hydratedOnly || localDateKey(_httpCore.ts) !== localDateKey(now)
      ? Number.POSITIVE_INFINITY
      : now - _httpCore.ts;
  return coreRefresh.serveStale(_httpCore.core, effectiveAge, TODAY_REFRESH_TTL, (err) => {
    _lastRefreshFailure = { at: Date.now(), message: toErrorMessage(err) };
    console.error("Background today refresh failed:", _lastRefreshFailure.message);
  });
}

async function rescanHttpCore(): Promise<void> {
  await ensureCoreFresh(true);
}

export function warmHttpCore(): void {
  let hydrated = false;
  if (!_httpCore && !coreRefresh.busy) {
    const core = new TokmeterCore();
    if (typeof core.hydrateFromDiskCache === "function" && core.hydrateFromDiskCache()) {
      const hydratedAt = computeHydratedTimestamp(core.getHomeDir?.() ?? homedir());
      _httpCore = { core, ts: hydratedAt, lastScanDurationMs: 0, hydratedOnly: true };
      _httpCoreReady = true;
      hydrated = true;
      console.log("【♾️】 HTTP core hydrated from disk cache — warming live scan");
    }
  }
  void (async () => {
    try {
      if (hydrated) {
        await coreRefresh.run(true);
      } else {
        await getHttpCore();
      }
      console.log("【♾️】 HTTP core warm — ready to serve");
    } catch (err) {
      _lastRefreshFailure = { at: Date.now(), message: toErrorMessage(err) };
      console.error("HTTP core warmup failed:", err);
    }
  })();
}

export function getWarmHttpCoreEntry(): HttpCoreEntry | null {
  return _httpCore;
}

export function flushHttpCoreRecordCache(): void {
  _httpCore?.core?.flushRecordCache?.();
}

export function closeHttpApi(): void {
  _onCoreEvent = null;
  _lastCompletedLocalDate = null;
  _hasCompletedLiveScan = false;
  _lastRefreshFailure = null;
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
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

function json(res: ServerResponse, data: unknown): void {
  res.end(JSON.stringify(data));
}

export interface HttpApiHandlers {
  getSessionManager: () => SessionManager | null;
  onListening: () => void;
  onBindError: (err: Error & { code?: string }) => void;
  onCoreEvent?: DaemonEventListener;
}

export function startHttpApi(handlers: HttpApiHandlers): void {
  _onCoreEvent = handlers.onCoreEvent ?? null;
  httpServer = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin ?? "";
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
    res.setHeader("Access-Control-Allow-Origin", isLocalhost ? origin : "http://localhost");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader(
      "Access-Control-Expose-Headers",
      `${API_HEADER}, ${LEGACY_API_HEADER}, ${SUMMARY_SOURCE_HEADER}`
    );
    res.setHeader("Content-Type", "application/json");
    for (const [name, value] of apiVersionHeaders(API_VERSION)) res.setHeader(name, value);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    if (!isAllowedHttpHost(req.headers.host)) {
      res.writeHead(403);
      res.end(JSON.stringify({ error: "Forbidden host" }));
      return;
    }

    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    if (!(req.method === "GET" && pathname === "/api/ready") && !checkAuth(req)) {
      res.writeHead(401);
      json(res, { error: "Unauthorized" });
      return;
    }

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const sessionManager = handlers.getSessionManager();

    try {
      if (req.method === "GET") {
        if (pathname === "/api/ready") {
          json(res, {
            ready: _httpCoreReady,
            warming: coreRefresh.busy,
            apiVersion: API_VERSION,
          });
          return;
        }

        if (pathname === "/api/quick") {
          const liveContextFillPct = sessionManager?.getAggregated().maxContextFillPct;
          if (_httpCore) {
            const rawStats = _httpCore.core.getStats();
            const stats = isLiveScanned() ? applyStatsFloor(rawStats) : rawStats;
            const blockElapsedPct = _httpCore.core.getStatbarSignals().billingWindow?.elapsedPct;
            json(res, { ready: true, stats, liveContextFillPct, blockElapsedPct });
          } else {
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

        if (pathname === "/api/summary") {
          const parsed = parseDaemonScopeQuery(url);
          if (parsed.error) {
            res.writeHead(400);
            json(res, { error: parsed.error });
            return;
          }
          if (parsed.hasScope) {
            const core = await getHttpCore();
            const scoped = executeScopedRoute(
              pathname,
              url,
              core,
              _httpCore?.lastScanDurationMs ?? 0
            );
            if (scoped) {
              if (scoped.headers) {
                for (const [k, v] of Object.entries(scoped.headers)) res.setHeader(k, v);
              }
              if (scoped.status !== 200) res.writeHead(scoped.status);
              json(res, scoped.body);
              return;
            }
          }
          const { summary, source } = await getHttpSummaryPayload();
          res.setHeader(SUMMARY_SOURCE_HEADER, source);
          json(res, summary);
          return;
        }

        if (pathname === "/api/live") {
          json(res, { aggregated: sessionManager?.getAggregated() ?? null });
          return;
        }

        if (pathname === "/api/today") {
          const warm = await getHttpCoreNoWait();
          const totals = computeTodayTotals(warm);
          json(res, {
            ...(isLiveScanned() ? applyTodayFloor(totals) : totals),
            computedAt: safeComputedAt(),
          });
          return;
        }

        if (pathname === "/api/statusline-context") {
          const qi = url.indexOf("?");
          const params = qi >= 0 ? new URLSearchParams(url.slice(qi + 1)) : new URLSearchParams();
          const project = params.get("project")?.trim() || undefined;
          const agent = params.get("agent")?.trim() || undefined;
          const warm = await getHttpCoreNoWait();
          const baseToday = computeTodayTotals(warm);
          const todayFloored = isLiveScanned() ? applyTodayFloor(baseToday) : baseToday;
          const computedAt = safeComputedAt();
          json(
            res,
            await buildStatuslineContext(warm, {
              project,
              agent,
              sessions: sessionManager?.getLive() ?? [],
              computedAt,
              homeDir: warm.getHomeDir?.(),
              todayFloored,
            })
          );
          return;
        }

        if (pathname === "/api/bar-snapshot") {
          const warm = await getHttpCoreNoWait();
          json(
            res,
            await buildBarSnapshot(warm, {
              applyFloor: isLiveScanned(),
              homeDir: homedir(),
              refreshing: coreRefresh.busy,
              computedAt: safeComputedAt(),
              todayDate: localDateKey(),
              extraPartialErrors: _lastRefreshFailure ? ["refresh"] : undefined,
            })
          );
          return;
        }

        const core = await getHttpCore();
        const scoped = executeScopedRoute(pathname, url, core, _httpCore?.lastScanDurationMs ?? 0);
        if (scoped) {
          if (scoped.headers) {
            for (const [k, v] of Object.entries(scoped.headers)) res.setHeader(k, v);
          }
          if (scoped.status !== 200) res.writeHead(scoped.status);
          json(res, scoped.body);
          return;
        }

        if (pathname === "/api/projects") {
          json(res, core.getAllProjects());
        } else if (pathname === "/api/sessions") {
          const today = new URL(url, "http://localhost").searchParams.get("today") === "true";
          json(res, readSessionsPayload(core, today, today ? localDateKey() : undefined));
        } else if (pathname.startsWith("/api/projects/")) {
          const name = decodeURIComponent(pathname.slice("/api/projects/".length));
          json(res, core.getProjectSummary(name) ?? { error: "Not found" });
        } else if (pathname === "/api/stats") {
          json(res, applyStatsFloor(core.getStats()));
        } else if (pathname === "/api/statbar-signals") {
          json(res, core.getStatbarSignals());
        } else if (pathname === "/api/session-ledger") {
          const transcript = new URL(url, "http://localhost").searchParams.get("transcript") ?? "";
          const ledger = _httpCore
            ? sessionLedgerForTranscript(transcript, _httpCore.core.getHomeDir?.())
            : null;
          json(res, ledger ?? { error: "Not found" });
        } else if (pathname === "/api/models") {
          json(res, core.getModelCosts());
        } else if (pathname === "/api/health") {
          json(res, readHealthPayload(core));
        } else if (pathname === "/api/today-models") {
          json(res, core.getModelCosts({ today: true, todayDate: localDateKey() }));
        } else if (pathname === "/api/rates") {
          const scope =
            new URL(url, "http://localhost").searchParams.get("scope") === "all" ? "all" : "today";
          json(res, await core.getModelRates(scope));
        } else if (pathname === "/api/cross-tool") {
          json(res, await core.getCrossToolComparison(localDateKey()));
        } else if (pathname === "/api/pricing-status") {
          json(res, readPricingStatusPayload(homedir()));
        } else if (pathname === "/api/anomalies") {
          json(res, readAnomaliesPayload(homedir()));
        } else if (pathname === "/api/coverage") {
          const { readCoverageReports } = await import("@sriinnu/tokmeter");
          json(res, { reports: await readCoverageReports(homedir(), 7) });
        } else if (pathname === "/api/quota") {
          const { getQuota } = await import("@sriinnu/tokmeter");
          json(res, {
            windows: await getQuota(homedir(), Date.now(), (msg) => console.warn(`[quota] ${msg}`)),
          });
        } else if (pathname === "/api/cron-status") {
          json(res, readCronStatusPayload(homedir()));
        } else if (pathname === "/api/daily") {
          json(res, readDailyFloored(core, true));
        } else if (pathname === "/api/providers") {
          json(res, core.getProviderBreakdown());
        } else if (pathname === "/api/antigravity-live") {
          json(res, await readAntigravityLivePayload());
        } else if (pathname === "/api/backups") {
          const { CleanupService } = await import("@sriinnu/tokmeter");
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
              "/api/statusline-context",
              "/api/bar-snapshot",
              "/api/summary",
              "/api/live",
              "/api/projects",
              "/api/sessions",
              "/api/stats",
              "/api/statbar-signals",
              "/api/models",
              "/api/rates",
              "/api/daily",
              "/api/providers",
              "/api/antigravity-live",
              "/api/backups",
              "/api/themes",
            ],
          });
        }
        return;
      }

      if (req.method === "POST") {
        if (pathname === "/api/update-pricing") {
          try {
            await refreshKoshaRegistry();
            await rescanHttpCore();
            json(res, { ok: true });
          } catch (err) {
            res.writeHead(500);
            json(res, { ok: false, error: err instanceof Error ? err.message : String(err) });
          }
        } else if (pathname === "/api/rescan") {
          try {
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
                // Missing pressure metric should not block user-initiated action.
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
              const qi = url.indexOf("?");
              const force =
                qi >= 0 && new URLSearchParams(url.slice(qi + 1)).get("force") === "true";
              _rescanInFlight = true;
              void core
                .rebuildRecentDays(DEEP_RESCAN_WINDOW_DAYS, Date.now(), force)
                .then(() => {
                  const finishedAt = Date.now();
                  _httpCore = {
                    core,
                    ts: finishedAt,
                    lastScanDurationMs: _httpCore?.lastScanDurationMs ?? 0,
                    hydratedOnly: false,
                  };
                  emitCoreEvent("refresh_completed", finishedAt);
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

  httpServer.requestTimeout = 20_000;
  httpServer.headersTimeout = 5_000;
  httpServer.maxHeadersCount = 32;

  let bound = false;
  httpServer.on("error", (err: Error & { code?: string }) => {
    if (!bound) {
      handlers.onBindError(err);
      return;
    }
    console.error("HTTP API error:", err.message);
  });

  httpServer.listen(HTTP_PORT, DAEMON_HOST, () => {
    bound = true;
    console.log(`【♾️】 HTTP API listening on http://${DAEMON_HOST}:${HTTP_PORT}`);
    console.log(`   Auth token: ${DAEMON_TOKEN_FILE}`);
    handlers.onListening();
  });
}

/**
 * Create an isolated loopback HTTP server backed by an injected `TokmeterCore`
 * for unit/integration tests without mutating process-wide daemon globals.
 */
export function createDaemonTestHttpServer(
  core: TokmeterCore,
  token: string,
  opts?: { sessions?: Session[]; homeDir?: string; quotas?: QuotaWindow[] }
) {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Content-Type", "application/json");
    for (const [name, value] of apiVersionHeaders(API_VERSION)) res.setHeader(name, value);
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];
    if (req.method === "GET" && pathname === "/api/ready") {
      json(res, { ready: true, warming: false, apiVersion: API_VERSION });
      return;
    }
    if (!isValidAuthHeader(req.headers.authorization, token)) {
      res.writeHead(401);
      json(res, { error: "Unauthorized" });
      return;
    }
    const scoped = executeScopedRoute(pathname, url, core, 1);
    if (scoped) {
      if (scoped.headers) {
        for (const [k, v] of Object.entries(scoped.headers)) res.setHeader(k, v);
      }
      if (scoped.status !== 200) res.writeHead(scoped.status);
      json(res, scoped.body);
      return;
    }
    if (pathname === "/api/quick") {
      const stats = core.getStats();
      const blockElapsedPct = core.getStatbarSignals().billingWindow?.elapsedPct;
      json(res, { ready: true, stats, blockElapsedPct });
      return;
    }
    if (pathname === "/api/summary") {
      res.setHeader(SUMMARY_SOURCE_HEADER, "live");
      json(res, core.getSummary());
      return;
    }
    if (pathname === "/api/stats") {
      json(res, core.getStats());
      return;
    }
    if (pathname === "/api/daily") {
      json(res, core.getDailyBreakdown());
      return;
    }
    if (pathname === "/api/models") {
      json(res, core.getModelCosts());
      return;
    }
    if (pathname === "/api/projects") {
      json(res, core.getAllProjects());
      return;
    }
    if (pathname === "/api/sessions") {
      const today = new URL(url, "http://localhost").searchParams.get("today") === "true";
      json(res, readSessionsPayload(core, today));
      return;
    }
    if (pathname.startsWith("/api/projects/")) {
      const name = decodeURIComponent(pathname.slice("/api/projects/".length));
      json(res, core.getProjectSummary(name) ?? { error: "Not found" });
      return;
    }
    if (pathname === "/api/providers") {
      json(res, core.getProviderBreakdown());
      return;
    }
    if (pathname === "/api/statbar-signals") {
      json(res, core.getStatbarSignals());
      return;
    }
    if (pathname === "/api/today") {
      json(res, { ...computeTodayTotals(core), computedAt: Date.now() });
      return;
    }
    if (pathname === "/api/statusline-context") {
      const qi = url.indexOf("?");
      const params = qi >= 0 ? new URLSearchParams(url.slice(qi + 1)) : new URLSearchParams();
      json(
        res,
        await buildStatuslineContext(core, {
          project: params.get("project")?.trim() || undefined,
          agent: params.get("agent")?.trim() || undefined,
          sessions: opts?.sessions ?? [],
          homeDir: opts?.homeDir,
          quotasOverride: opts?.quotas,
        })
      );
      return;
    }
    if (pathname === "/api/rates") {
      const scope =
        new URL(url, "http://localhost").searchParams.get("scope") === "all" ? "all" : "today";
      json(res, await core.getModelRates(scope));
      return;
    }
    if (pathname === "/api/quota") {
      json(res, { windows: opts?.quotas ?? (await getCachedQuota(opts?.homeDir ?? homedir())) });
      return;
    }
    if (pathname === "/api/cross-tool") {
      json(res, await core.getCrossToolComparison());
      return;
    }
    if (pathname === "/api/health") {
      json(res, readHealthPayload(core));
      return;
    }
    if (pathname === "/api/pricing-status") {
      json(res, readPricingStatusPayload(opts?.homeDir ?? homedir()));
      return;
    }
    if (pathname === "/api/anomalies") {
      json(res, readAnomaliesPayload(opts?.homeDir ?? homedir()));
      return;
    }
    if (pathname === "/api/cron-status") {
      json(res, readCronStatusPayload(opts?.homeDir ?? homedir()));
      return;
    }
    if (pathname === "/api/antigravity-live") {
      json(res, await readAntigravityLivePayload());
      return;
    }
    if (pathname === "/api/bar-snapshot") {
      json(
        res,
        await buildBarSnapshot(core, {
          applyFloor: false,
          homeDir: opts?.homeDir,
          quotasOverride: opts?.quotas,
          refreshing: false,
          computedAt: Date.now(),
        })
      );
      return;
    }
    res.writeHead(404);
    json(res, { error: "Not found" });
  });
}
