/**
 * @sriinnu/tokmeter-core — Plan quota: how much of each agent's rate-limit
 * window is used, and whether the current pace runs out before it resets.
 *
 * Two sources, neither of them a token count:
 * - Codex writes `rate_limits` on every `token_count` event: the weekly window's
 *   used %, its reset time and the credit balance. The newest rollouts carry the
 *   newest reading, so only their tails are read, never a rescan.
 * - Claude Code hands its 5-hour and 7-day windows to the statusline command on
 *   stdin and writes them nowhere. The statusline records them here.
 *
 * A window is fixed, not rolling: it starts at `resetsAt - windowMinutes` and
 * its used % only grows until the reset. Parallel Codex threads report a stale
 * server snapshot now and then (1% lower, seconds apart), so the reading for a
 * window is the max seen, never the last one. A window can also be replaced
 * before its reset (a fresh window opened on 2026-10-18 while the old one still
 * ran to 10-22), so the newest window wins.
 *
 * Samples persist to ~/.cache/tokmeter/quota/<agent>.jsonl, one line per change,
 * which is what the recent pace is measured from.
 */

import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { localDateKey } from "./date-utils.js";
import { codexHomeDir } from "./parsers/codex.js";

export type QuotaAgent = "codex" | "claude-code";

/** One reading of one window, as the agent reported it. */
export interface QuotaSample {
  agent: QuotaAgent;
  /** Window length: 300 for a 5-hour window, 10080 for a weekly one. */
  windowMinutes: number;
  usedPct: number;
  /** When the window resets, epoch seconds. */
  resetsAt: number;
  /** When the agent reported it, epoch ms. */
  at: number;
  plan?: string;
  /** Codex only: prepaid credits left, in the plan's credit unit. */
  creditsBalance?: number;
}

export type QuotaVerdict = "resets-first" | "hits-limit" | "at-limit" | "expired";

/** A window with its forecast — what /api/quota and `tokmeter quota` show. */
export interface QuotaWindow {
  agent: QuotaAgent;
  /** "5h", "7d", or the length in minutes/hours for anything else. */
  window: string;
  windowMinutes: number;
  usedPct: number;
  /** Epoch seconds. */
  windowStart: number;
  resetsAt: number;
  /** When the newest reading was taken, epoch ms. Usage elsewhere on the
   *  account (another machine, the web) shows up only at the next reading. */
  sampledAt: number;
  plan?: string;
  creditsBalance?: number;
  /** Used % per hour since the window opened. */
  avgPctPerHour: number;
  /** Used % per hour over the last few hours of readings; null with too few. */
  recentPctPerHour: number | null;
  /** When the pace in use reaches 100%, epoch seconds; null if it resets first. */
  hitsLimitAt: number | null;
  verdict: QuotaVerdict;
}

const RECENT_PACE_HOURS = 6;
/** Below this span, a rate between two readings is noise. */
const RECENT_PACE_MIN_MINUTES = 30;
/** Store lines older than this are dropped when the file is compacted. */
const STORE_KEEP_MS = 8 * 86_400_000;
const STORE_COMPACT_BYTES = 256 * 1024;
const CODEX_TAIL_BYTES = 256 * 1024;
const CODEX_NEWEST_FILES = 3;

export function windowLabel(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * Codex's `resets_at` jitters by a second between readings of one window
 * (10-25 13:13:14 vs 13:13:29 were the same window), so windows match by the
 * reset minute.
 */
function sameWindow(a: QuotaSample, b: QuotaSample): boolean {
  return (
    a.agent === b.agent &&
    a.windowMinutes === b.windowMinutes &&
    Math.abs(a.resetsAt - b.resetsAt) < 120
  );
}

// ─── Codex ────────────────────────────────────────────────────────────────

interface CodexRateWindow {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** The samples in one rollout line, or none. Exported for tests. */
export function codexQuotaFromLine(line: string): QuotaSample[] {
  if (!line.includes('"rate_limits"')) return [];
  let evt: {
    timestamp?: string;
    payload?: {
      type?: string;
      rate_limits?: {
        primary?: CodexRateWindow | null;
        secondary?: CodexRateWindow | null;
        plan_type?: string | null;
        credits?: { balance?: string | number | null } | null;
      } | null;
    };
  };
  try {
    evt = JSON.parse(line);
  } catch {
    return [];
  }
  const rl = evt.payload?.type === "token_count" ? evt.payload.rate_limits : undefined;
  if (!rl || !evt.timestamp) return [];
  const at = Date.parse(evt.timestamp);
  if (!Number.isFinite(at)) return [];
  const balance = Number(rl.credits?.balance);
  const out: QuotaSample[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (
      !w ||
      typeof w.used_percent !== "number" ||
      !Number.isFinite(w.used_percent) ||
      typeof w.window_minutes !== "number" ||
      w.window_minutes <= 0 ||
      typeof w.resets_at !== "number"
    ) {
      continue;
    }
    out.push({
      agent: "codex",
      windowMinutes: w.window_minutes,
      usedPct: w.used_percent,
      resetsAt: w.resets_at,
      at,
      ...(rl.plan_type ? { plan: rl.plan_type } : {}),
      ...(rl.credits?.balance != null && Number.isFinite(balance)
        ? { creditsBalance: balance }
        : {}),
    });
  }
  return out;
}

/** Rollout names carry their start time: rollout-2026-10-21T15-16-52-<id>.jsonl */
const ROLLOUT_NAME = /^rollout-(\d{4}-\d{2}-\d{2})T.*\.jsonl$/;

async function recentRollouts(dir: string, sinceDay: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => {
      const m = ROLLOUT_NAME.exec(n);
      return m?.[1] !== undefined && m[1] >= sinceDay;
    })
    .map((n) => join(dir, n));
}

async function readTail(file: string, bytes: number): Promise<string> {
  const fh = await open(file, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    const text = buf.toString("utf8");
    // A tail cut mid-line starts with a fragment; drop it.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    await fh.close();
  }
}

/**
 * The newest Codex readings: the tails of the few most recently written
 * rollouts, live or archived. A long-idle week is fine — a thread started any
 * day this week still gets found by its name. Compressed (.zst) rollouts are
 * idle ones, so never the newest.
 */
export async function readCodexQuota(homeDir: string, now = Date.now()): Promise<QuotaSample[]> {
  const home = codexHomeDir(homeDir);
  const days: string[] = [];
  for (let i = 0; i <= 7; i++) days.push(localDateKey(now - i * 86_400_000));
  const sinceDay = days[days.length - 1] as string;
  const dirs = [
    ...days.map((d) => join(home, "sessions", ...d.split("-"))),
    join(home, "archived_sessions"),
  ];
  const files = (await Promise.all(dirs.map((d) => recentRollouts(d, sinceDay)))).flat();
  const stamped = await Promise.all(
    files.map(async (f) => {
      try {
        return { f, mtime: (await stat(f)).mtimeMs };
      } catch {
        return { f, mtime: 0 };
      }
    })
  );
  const newest = stamped
    .filter((s) => s.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, CODEX_NEWEST_FILES);
  const samples: QuotaSample[] = [];
  for (const { f } of newest) {
    const tail = await readTail(f, CODEX_TAIL_BYTES);
    for (const line of tail.split("\n")) samples.push(...codexQuotaFromLine(line));
  }
  return samples;
}

// ─── Claude Code ──────────────────────────────────────────────────────────

interface ClaudeRateWindow {
  used_percentage?: number;
  resets_at?: number;
}

/** The statusline's `rate_limits` block as samples. */
export function claudeCodeQuota(
  rateLimits: { five_hour?: ClaudeRateWindow; seven_day?: ClaudeRateWindow } | undefined,
  now = Date.now()
): QuotaSample[] {
  const out: QuotaSample[] = [];
  for (const [w, minutes] of [
    [rateLimits?.five_hour, 300],
    [rateLimits?.seven_day, 10080],
  ] as const) {
    if (
      typeof w?.used_percentage !== "number" ||
      !Number.isFinite(w.used_percentage) ||
      typeof w.resets_at !== "number"
    ) {
      continue;
    }
    out.push({
      agent: "claude-code",
      windowMinutes: minutes,
      usedPct: w.used_percentage,
      resetsAt: w.resets_at,
      at: now,
    });
  }
  return out;
}

// ─── Store: ~/.cache/tokmeter/quota/<agent>.jsonl ─────────────────────────

function quotaDir(homeDir: string): string {
  return join(homeDir, ".cache", "tokmeter", "quota");
}

function storeFile(homeDir: string, agent: QuotaAgent): string {
  return join(quotaDir(homeDir), `${agent}.jsonl`);
}

function parseStore(text: string): QuotaSample[] {
  const out: QuotaSample[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const s = JSON.parse(line) as QuotaSample;
      if (typeof s.usedPct === "number" && typeof s.resetsAt === "number") out.push(s);
    } catch {
      /* a torn line from a crashed writer is skipped, never fatal */
    }
  }
  return out;
}

export function readQuotaStore(homeDir: string, agent: QuotaAgent): QuotaSample[] {
  try {
    return parseStore(readFileSync(storeFile(homeDir, agent), "utf8"));
  } catch {
    return [];
  }
}

/**
 * Append the readings that say something new: a window not seen yet, or a
 * higher used %. Synchronous and small, because the statusline calls it on
 * every render. Lines are appended whole, so concurrent writers interleave
 * lines, never bytes.
 */
export function recordQuotaSamples(homeDir: string, samples: QuotaSample[]): void {
  const byAgent = new Map<QuotaAgent, QuotaSample[]>();
  for (const s of samples) byAgent.set(s.agent, [...(byAgent.get(s.agent) ?? []), s]);
  for (const [agent, fresh] of byAgent) {
    const file = storeFile(homeDir, agent);
    const known = readQuotaStore(homeDir, agent);
    const add: QuotaSample[] = [];
    for (const s of [...fresh].sort((a, b) => a.at - b.at)) {
      const best = [...known, ...add]
        .filter((k) => sameWindow(k, s))
        .reduce((m, k) => Math.max(m, k.usedPct), Number.NEGATIVE_INFINITY);
      if (s.usedPct > best) add.push(s);
    }
    if (add.length === 0) continue;
    try {
      mkdirSync(quotaDir(homeDir), { recursive: true });
      appendFileSync(file, add.map((s) => `${JSON.stringify(s)}\n`).join(""), { mode: 0o600 });
      if (statSync(file).size > STORE_COMPACT_BYTES) {
        const keep = readQuotaStore(homeDir, agent).filter(
          (s) => s.at >= Date.now() - STORE_KEEP_MS
        );
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, keep.map((s) => `${JSON.stringify(s)}\n`).join(""), { mode: 0o600 });
        renameSync(tmp, file);
      }
    } catch {
      /* quota is advisory; a full disk must not break a statusline render */
    }
  }
}

// ─── Forecast ─────────────────────────────────────────────────────────────

/**
 * The current windows with their pace. `samples` may hold every reading ever
 * stored; only the newest window per agent and length is kept.
 */
export function quotaWindows(samples: QuotaSample[], now = Date.now()): QuotaWindow[] {
  const groups: QuotaSample[][] = [];
  for (const s of samples) {
    const g = groups.find((x) => x[0] !== undefined && sameWindow(x[0], s));
    if (g) g.push(s);
    else groups.push([s]);
  }
  // Newest window per agent and length: the one reported most recently.
  const current = new Map<string, QuotaSample[]>();
  for (const g of groups) {
    const key = `${g[0]?.agent}:${g[0]?.windowMinutes}`;
    const latest = Math.max(...g.map((s) => s.at));
    const have = current.get(key);
    if (!have || latest > Math.max(...have.map((s) => s.at))) current.set(key, g);
  }
  const out: QuotaWindow[] = [];
  for (const g of current.values()) out.push(forecast(g, now));
  return out.sort((a, b) => a.agent.localeCompare(b.agent) || a.windowMinutes - b.windowMinutes);
}

function forecast(g: QuotaSample[], now: number): QuotaWindow {
  const sorted = [...g].sort((a, b) => a.at - b.at);
  const newest = sorted[sorted.length - 1] as QuotaSample;
  const usedPct = Math.max(...sorted.map((s) => s.usedPct));
  const resetsAt = Math.max(...sorted.map((s) => s.resetsAt));
  const windowStart = resetsAt - newest.windowMinutes * 60;
  const elapsedH = Math.max(0, (newest.at / 1000 - windowStart) / 3600);
  const avgPctPerHour = elapsedH > 0 ? usedPct / elapsedH : 0;

  let recentPctPerHour: number | null = null;
  const recent = sorted.filter((s) => s.at >= newest.at - RECENT_PACE_HOURS * 3_600_000);
  const first = recent[0];
  if (first && newest.at - first.at >= RECENT_PACE_MIN_MINUTES * 60_000) {
    recentPctPerHour = Math.max(
      0,
      (usedPct - first.usedPct) / ((newest.at - first.at) / 3_600_000)
    );
  }

  const base: Omit<QuotaWindow, "hitsLimitAt" | "verdict"> = {
    agent: newest.agent,
    window: windowLabel(newest.windowMinutes),
    windowMinutes: newest.windowMinutes,
    usedPct,
    windowStart,
    resetsAt,
    sampledAt: newest.at,
    ...(newest.plan ? { plan: newest.plan } : {}),
    ...(newest.creditsBalance !== undefined ? { creditsBalance: newest.creditsBalance } : {}),
    avgPctPerHour,
    recentPctPerHour,
  };
  if (resetsAt * 1000 <= now) return { ...base, hitsLimitAt: null, verdict: "expired" };
  if (usedPct >= 100) return { ...base, hitsLimitAt: null, verdict: "at-limit" };
  // The recent pace when there is one: a burst this afternoon says more about
  // tonight than a quiet Monday does.
  const rate = recentPctPerHour ?? avgPctPerHour;
  if (rate <= 0) return { ...base, hitsLimitAt: null, verdict: "resets-first" };
  const hitsLimitAt = Math.round(newest.at / 1000 + ((100 - usedPct) / rate) * 3600);
  return hitsLimitAt < resetsAt
    ? { ...base, hitsLimitAt, verdict: "hits-limit" }
    : { ...base, hitsLimitAt: null, verdict: "resets-first" };
}

/**
 * Read Codex's newest readings, record them, and return every agent's current
 * windows. The daemon serves this as /api/quota; the CLI runs it directly.
 */
export async function getQuota(homeDir: string, now = Date.now()): Promise<QuotaWindow[]> {
  recordQuotaSamples(homeDir, await readCodexQuota(homeDir, now));
  return quotaWindows(
    [...readQuotaStore(homeDir, "codex"), ...readQuotaStore(homeDir, "claude-code")],
    now
  );
}
