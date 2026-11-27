/**
 * Snapshot and read-payload builders for statusline, menubar, and health endpoints.
 */

import {
  closeSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  localDateKey,
  peekCachedRecords,
  type QuotaWindow,
  type TokmeterCore,
} from "@sriinnu/tokmeter";
import { applyTodayFloor, computeTodayTotals, type TodayTotals } from "./floors.js";
import type { Session } from "./session.js";
import { computeSessionLedger } from "./session-ledger.js";

export interface StatuslineContextResponse {
  today: TodayTotals & { computedAt: number };
  repo: { name: string; cost: number; in: number; out: number } | null;
  liveSessions: {
    count: number;
    others: string[];
    active: Array<{
      provider: string;
      sessionId: string;
      model: string;
      project?: string;
      cost: number;
      contextFillPct?: number;
      lastUpdate: number;
    }>;
  };
  paceMultiple: number | null;
  subagentToday: { cost: number; share: number; records: number };
  dailyCostThreshold: number | null;
  unpricedModelsCount: number;
  quotas: QuotaWindow[];
  computedAt: number;
}

const QUOTA_CACHE_TTL_MS = 15_000;
const _quotaCache = new Map<
  string,
  { windows: QuotaWindow[]; at: number; refreshing?: Promise<void> }
>();
const _quotaInFlight = new Map<string, Promise<QuotaWindow[]>>();

/** Reset cached quota entries (intended for tests). */
export function clearQuotaCacheForTests(): void {
  _quotaCache.clear();
  _quotaInFlight.clear();
}

export async function getCachedQuota(homeDir: string): Promise<QuotaWindow[]> {
  const now = Date.now();
  const entry = _quotaCache.get(homeDir);
  const fetchFresh = async (): Promise<QuotaWindow[]> => {
    const existing = _quotaInFlight.get(homeDir);
    if (existing) return existing;
    let p!: Promise<QuotaWindow[]>;
    p = (async () => {
      try {
        const { getQuota } = await import("@sriinnu/tokmeter");
        const windows = await getQuota(homeDir, Date.now(), (msg) =>
          console.warn(`[quota] ${msg}`)
        );
        _quotaCache.set(homeDir, { windows, at: Date.now() });
        return windows;
      } finally {
        if (_quotaInFlight.get(homeDir) === p) _quotaInFlight.delete(homeDir);
      }
    })();
    _quotaInFlight.set(homeDir, p);
    return p;
  };
  if (!entry) {
    return fetchFresh();
  }
  if (now - entry.at >= QUOTA_CACHE_TTL_MS && !entry.refreshing) {
    entry.refreshing = fetchFresh()
      .catch(() => entry.windows)
      .then(() => {
        const cur = _quotaCache.get(homeDir);
        if (cur) delete cur.refreshing;
      });
  }
  return entry.windows;
}

function normalizeProjectMatchKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export async function buildStatuslineContext(
  core: TokmeterCore,
  opts: {
    project?: string;
    agent?: string;
    sessions?: Session[];
    computedAt?: number;
    homeDir?: string;
    todayFloored?: TodayTotals;
    quotasOverride?: QuotaWindow[];
  } = {}
): Promise<StatuslineContextResponse> {
  const computedAt = opts.computedAt ?? Date.now();
  const homeDir = opts.homeDir ?? core.getHomeDir?.() ?? homedir();
  const baseToday = opts.todayFloored ?? computeTodayTotals(core);
  const today = { ...baseToday, computedAt };

  const coreApi = await import("@sriinnu/tokmeter");
  let repo: StatuslineContextResponse["repo"] = null;
  if (opts.project) {
    const slug = opts.project.replace(/[^A-Za-z0-9]/g, "-");
    const needles = new Set(
      [
        coreApi.canonicalizeProjectName(opts.project, ""),
        coreApi.canonicalizeProjectName(slug, ""),
        opts.project,
      ]
        .map(normalizeProjectMatchKey)
        .filter(Boolean)
    );
    let cost = 0;
    let inTok = 0;
    let outTok = 0;
    let matchedName: string | null = null;
    for (const [key, val] of Object.entries(today.projects)) {
      if (!needles.has(normalizeProjectMatchKey(key))) continue;
      if (!matchedName) matchedName = key;
      cost += val.cost;
      inTok += val.in;
      outTok += val.out;
    }
    if (matchedName !== null) {
      repo = { name: matchedName, cost, in: inTok, out: outTok };
    }
  }

  let paceMultiple: number | null = null;
  let subagentToday = { cost: 0, share: 0, records: 0 };
  if (typeof core.getStatbarSignals === "function") {
    try {
      const sig = core.getStatbarSignals();
      paceMultiple = sig.pace?.multiple ?? null;
      if (sig.subagentToday) {
        subagentToday = {
          cost: sig.subagentToday.cost,
          share: sig.subagentToday.share,
          records: sig.subagentToday.records,
        };
      }
    } catch {}
  }

  let unpricedModelsCount = 0;
  if (typeof core.getScanMeta === "function") {
    try {
      unpricedModelsCount = core.getScanMeta().unpricedModels.length;
    } catch {}
  }

  let dailyCostThreshold: number | null = null;
  try {
    dailyCostThreshold = coreApi.loadConfig(homeDir).alerts.dailyCostThreshold;
  } catch {}

  const live = (opts.sessions ?? [])
    .filter((s) => !s.ended)
    .slice()
    .sort((a, b) => b.lastUpdate - a.lastUpdate);
  const filteredOthers = new Set<string>();
  for (const s of live) {
    if (!opts.agent || s.provider !== opts.agent) {
      filteredOthers.add(s.provider);
    }
  }
  const active = live.slice(0, 16).map((s) => {
    const pct =
      s.contextWindow && s.contextWindow.maxTokens > 0
        ? (s.contextWindow.usedTokens / s.contextWindow.maxTokens) * 100
        : undefined;
    return {
      provider: s.provider,
      sessionId: s.sessionId,
      model: s.model,
      ...(s.project ? { project: s.project } : {}),
      cost: s.cost,
      ...(pct !== undefined && Number.isFinite(pct) ? { contextFillPct: pct } : {}),
      lastUpdate: s.lastUpdate,
    };
  });

  let quotas: QuotaWindow[] = [];
  if (opts.quotasOverride !== undefined) {
    quotas = opts.quotasOverride;
  } else {
    try {
      quotas = await getCachedQuota(homeDir);
    } catch {
      quotas = [];
    }
  }

  return {
    today,
    repo,
    liveSessions: {
      count: live.length,
      others: [...filteredOthers],
      active,
    },
    paceMultiple,
    subagentToday,
    dailyCostThreshold,
    unpricedModelsCount,
    quotas,
    computedAt,
  };
}

export function readDailyFloored(core: TokmeterCore, applyFloor: boolean) {
  const daily = core.getDailyBreakdown().map((entry) => ({ ...entry }));
  if (!applyFloor) return daily;
  const todayKey = localDateKey();
  const floored = applyTodayFloor(computeTodayTotals(core));
  if (daily.length > 0 && daily[daily.length - 1]?.date === todayKey) {
    const last = daily[daily.length - 1];
    if (floored.cost > last.cost) last.cost = floored.cost;
    const flooredTokens = floored.in + floored.out;
    if (flooredTokens > last.totalTokens) last.totalTokens = flooredTokens;
  }
  return daily;
}

export function readSessionsPayload(core: TokmeterCore, today: boolean, todayDate?: string) {
  return core
    .getAllProjects({ today, ...(todayDate !== undefined ? { todayDate } : {}) })
    .slice()
    .sort((a: { lastUsed: number }, b: { lastUsed: number }) => b.lastUsed - a.lastUsed)
    .slice(0, 50);
}

export function readHealthPayload(core: TokmeterCore) {
  const meta = core.getScanMeta();
  const UNPRICED_CAP = 100;
  const allUnpriced = meta.unpricedModels;
  return {
    ready: true,
    unpricedModels: allUnpriced.slice(0, UNPRICED_CAP),
    unpricedModelsTotal: allUnpriced.length,
    unpricedModelsTruncated: allUnpriced.length > UNPRICED_CAP,
    unpricedRecords: meta.unpricedRecords,
    warnings: meta.warnings,
    lastScanAt: meta.lastScanAt,
  };
}

export function readPricingStatusPayload(homeDir = homedir()): { registryMtime: number } {
  let mtime = 0;
  try {
    const path = join(homeDir, ".kosha", "registry.json");
    if (existsSync(path)) {
      const fd = openSync(path, fsConstants.O_RDONLY);
      try {
        mtime = fstatSync(fd).mtimeMs;
      } finally {
        closeSync(fd);
      }
    }
  } catch {}
  return { registryMtime: mtime };
}

export function readCronStatusPayload(homeDir = homedir()) {
  const plistPath = join(homeDir, "Library", "LaunchAgents", "com.sriinnu.tokmeter.daily.plist");
  const logPath = join(homeDir, ".cache", "tokmeter", "daily-cron.log");
  let installed = false;
  let lastRunMtime = 0;
  let lastRunOk: boolean | null = null;
  let lastRunTail = "";
  try {
    installed = existsSync(plistPath);
  } catch {}
  try {
    const fd = openSync(logPath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    try {
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
      if (data.includes("Kosha registry refreshed")) lastRunOk = true;
      else if (data.includes("Failed to refresh kosha")) lastRunOk = false;
    } finally {
      closeSync(fd);
    }
  } catch {}
  return { installed, lastRunMtime, lastRunOk, lastRunTail };
}

export function readAnomaliesPayload(homeDir = homedir()) {
  const ANOM_CAP = 50;
  const TWENTY_FOUR_H = 24 * 3600 * 1000;
  let recent: unknown[] = [];
  let total = 0;
  try {
    const parsed = JSON.parse(readFileSync(join(homeDir, ".kosha", "anomalies.json"), "utf-8")) as {
      anomalies?: Array<{ ts: number }>;
    };
    const cutoff = Date.now() - TWENTY_FOUR_H;
    const all = (parsed.anomalies ?? []).filter((a) => a.ts >= cutoff);
    total = all.length;
    recent = all.slice(-ANOM_CAP).reverse();
  } catch {}
  return { anomalies: recent, total, cappedAt: ANOM_CAP };
}

export async function readAntigravityLivePayload() {
  const { computeCreditsUsedToday, readLatestAntigravitySnapshot } = await import(
    "@sriinnu/tokmeter"
  );
  return {
    latestSnapshot: readLatestAntigravitySnapshot(),
    creditsUsedToday: computeCreditsUsedToday(),
  };
}

/**
 * Only ever touch the filesystem for a `.jsonl` under a Claude Code projects
 * dir (default or `CLAUDE_CONFIG_DIR`).
 */
function isTranscriptPath(p: string): boolean {
  if (typeof p !== "string" || !p.endsWith(".jsonl") || p.includes("/../") || p.includes("\0")) {
    return false;
  }
  const roots = [join(homedir(), ".claude", "projects")];
  if (process.env.CLAUDE_CONFIG_DIR) roots.push(join(process.env.CLAUDE_CONFIG_DIR, "projects"));
  return roots.some((root) => p.startsWith(`${root}/`));
}

/**
 * Whole-session ledger for a transcript: main file plus nested subagent runs
 * read strictly from the cached record entries.
 */
export function sessionLedgerForTranscript(transcriptPath: string, homeDir?: string) {
  if (!isTranscriptPath(transcriptPath)) return null;
  const files = [transcriptPath];
  const subagentDir = `${transcriptPath.slice(0, -".jsonl".length)}/subagents`;
  try {
    for (const f of readdirSync(subagentDir).slice(0, 256)) {
      if (f.endsWith(".jsonl")) files.push(`${subagentDir}/${f}`);
    }
  } catch {}
  const records = files.flatMap((f) => peekCachedRecords(f, homeDir) ?? []);
  return records.length > 0 ? computeSessionLedger(records, transcriptPath) : null;
}

export interface BarSnapshotResponse {
  daily: ReturnType<TokmeterCore["getDailyBreakdown"]>;
  models: ReturnType<TokmeterCore["getModelCosts"]>;
  todayModels: ReturnType<TokmeterCore["getModelCosts"]>;
  sessions: ReturnType<TokmeterCore["getAllProjects"]>;
  todayProjects: ReturnType<TokmeterCore["getAllProjects"]>;
  pricingStatus: ReturnType<typeof readPricingStatusPayload> | null;
  cronStatus: ReturnType<typeof readCronStatusPayload> | null;
  health: ReturnType<typeof readHealthPayload> | null;
  anomalies: ReturnType<typeof readAnomaliesPayload> | null;
  statbarSignals: ReturnType<TokmeterCore["getStatbarSignals"]> | null;
  crossTool: Awaited<ReturnType<TokmeterCore["getCrossToolComparison"]>> | null;
  quota: { windows: QuotaWindow[] } | null;
  antigravityLive: Awaited<ReturnType<typeof readAntigravityLivePayload>> | null;
  partialErrors: string[];
  refreshing?: boolean;
  computedAt?: number;
}

/**
 * Consolidated Phase-2 payload for the macOS menubar app (`/api/bar-snapshot`),
 * collapsing 13 separate GET requests into one HTTP round-trip while tracking
 * per-section failures in `partialErrors`.
 */
export async function buildBarSnapshot(
  core: TokmeterCore,
  opts: {
    applyFloor?: boolean;
    homeDir?: string;
    quotasOverride?: QuotaWindow[];
    refreshing?: boolean;
    computedAt?: number;
    todayDate?: string;
    extraPartialErrors?: string[];
  } = {}
): Promise<BarSnapshotResponse> {
  const home = opts.homeDir ?? core.getHomeDir?.() ?? homedir();
  const partialErrors: string[] = [];
  for (const err of opts.extraPartialErrors ?? []) {
    if (!partialErrors.includes(err)) partialErrors.push(err);
  }

  const capture = <T>(name: string, fn: () => T): T | null => {
    try {
      return fn();
    } catch {
      partialErrors.push(name);
      return null;
    }
  };
  const captureAsync = async <T>(name: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      partialErrors.push(name);
      return null;
    }
  };

  const daily = readDailyFloored(core, opts.applyFloor === true);
  const models = core.getModelCosts();
  const todayModels = core.getModelCosts({
    today: true,
    ...(opts.todayDate !== undefined ? { todayDate: opts.todayDate } : {}),
  });
  const sessions = readSessionsPayload(core, false);
  const todayProjects = readSessionsPayload(core, true, opts.todayDate);
  const pricingStatus = capture("pricingStatus", () => readPricingStatusPayload(home));
  const cronStatus = capture("cronStatus", () => readCronStatusPayload(home));
  const health = capture("health", () => readHealthPayload(core));
  const anomalies = capture("anomalies", () => readAnomaliesPayload(home));
  const statbarSignals = capture("statbarSignals", () => core.getStatbarSignals());

  const [crossTool, quotaWindows, antigravityLive] = await Promise.all([
    captureAsync("crossTool", () => core.getCrossToolComparison(opts.todayDate)),
    opts.quotasOverride !== undefined
      ? Promise.resolve(opts.quotasOverride)
      : captureAsync("quota", () => getCachedQuota(home)),
    captureAsync("antigravityLive", () => readAntigravityLivePayload()),
  ]);

  return {
    daily,
    models,
    todayModels,
    sessions,
    todayProjects,
    pricingStatus,
    cronStatus,
    health,
    anomalies,
    statbarSignals,
    crossTool,
    quota: quotaWindows !== null ? { windows: quotaWindows } : null,
    antigravityLive,
    partialErrors,
    ...(opts.refreshing !== undefined ? { refreshing: opts.refreshing } : {}),
    ...(opts.computedAt !== undefined ? { computedAt: opts.computedAt } : {}),
  };
}
