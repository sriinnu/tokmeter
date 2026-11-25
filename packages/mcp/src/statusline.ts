/**
 * @sriinnu/tokmeter-mcp — Claude Code statusline hook handler.
 *
 * Two-line instrument (drawn by statusline-view.ts):
 *   line 1 — this session: project · model · context · prompt cache (hit
 *            share, breaks, time left) · session cost · branch · PR.
 *   line 2 — the limits and the day: the one alert that matters most, the
 *            plan windows (5h / 7d), a gateway spend limit, today's spend
 *            across every agent and this repo's part of it.
 *
 * Session numbers come from the harness's own payload. Today's totals come
 * from the Tokmeter daemon; nothing on this path reads a transcript.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  canonicalizeProjectName,
  claudeCodeQuota,
  ensurePrivateDirectory,
  getKoshaRegistryMtime,
  getQuota,
  loadConfig,
  localDateKey,
  type QuotaWindow,
  readDaemonAuthHeader,
  recordQuotaSamples,
  resolveDaemonHttpBase,
  STATUSLINE_DENSITIES,
  STATUSLINE_STYLES,
  type StatuslineDensity,
  type StatuslineStyle,
  writePrivateFile,
} from "@sriinnu/tokmeter";
import type { TokenUsage } from "./daemon/protocol.js";
import type { SessionPush } from "./daemon/push.js";
import type { StatuslineContextResponse } from "./daemon/server.js";
import { C, FALLBACK_STATUSLINE } from "./formatter.js";
import {
  type CacheView,
  type PrReviewState,
  type RateWindowView,
  type RouteView,
  renderStatusline,
  type SpendLimitView,
  type StatuslineFormat,
  type StatusView,
} from "./statusline-view.js";

// ─── Hot-path caches ────────────────────────────────────────────────────
// The statusline runs as a fresh subprocess every ~200ms. To avoid
// re-doing expensive work (repo subprocesses, full disk scan), we persist
// short-lived results to a per-user cache dir and read them back if fresh.
//
// Per-user dir is critical: a shared /tmp file would leak one user's
// totals to another on multi-user systems, and on Linux a predictable name in
// the sticky /tmp lets another user pre-create it (or a symlink) first. The
// cache lives in $XDG_RUNTIME_DIR (per-user, 0700, set by systemd/logind) when
// present, else under ~/.cache/tokmeter. The dir is forced to 0700 and owned by
// us; files are written atomically as 0600 without following symlinks.

/** Where the statusline keeps its hot-path caches for this user. */
export function statuslineCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir()
): string {
  const runtime = env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, "tokmeter-statusline");
  return join(home, ".cache", "tokmeter", "statusline");
}

let cacheDirResolved = false;
let cacheDir: string | null = null;

/**
 * The private cache dir, created on first use; null when it can't be made
 * safe (wrong owner, a symlink, unwritable) — the statusline then runs
 * uncached rather than writing somewhere another user controls.
 */
function getCacheDir(): string | null {
  if (cacheDirResolved) return cacheDir;
  cacheDirResolved = true;
  const dir = statuslineCacheDir();
  try {
    ensurePrivateDirectory(dir);
    cacheDir = dir;
  } catch {
    cacheDir = null;
  }
  return cacheDir;
}

function cacheFile(name: string): string | null {
  const dir = getCacheDir();
  return dir ? join(dir, name) : null;
}

interface CacheWrapper<T> {
  ts: number;
  data: T;
  /** Optional invalidation key — e.g. file mtime — for content-aware caches. */
  key?: string;
}

function readCache<T>(path: string | null, ttlMs: number, expectedKey?: string): T | null {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const wrapper = JSON.parse(raw) as CacheWrapper<T>;
    // Content-aware invalidation: if the key changed (e.g. .git/HEAD mtime),
    // discard immediately even if within TTL.
    if (expectedKey !== undefined && wrapper.key !== expectedKey) return null;
    if (Date.now() - wrapper.ts > ttlMs) return null;
    return wrapper.data;
  } catch {
    // Corrupt cache file — delete it so it doesn't keep failing.
    try {
      unlinkSync(path);
    } catch {}
    return null;
  }
}

function writeCache<T>(path: string | null, data: T, key?: string): void {
  if (!path) return;
  try {
    const wrapper: CacheWrapper<T> = { ts: Date.now(), data };
    if (key !== undefined) wrapper.key = key;
    writePrivateFile(path, JSON.stringify(wrapper));
  } catch {}
}

function cwdHash(cwd: string): string {
  return createHash("sha1").update(cwd).digest("hex").slice(0, 12);
}

/** mtime of a file as a string, or "" if it doesn't exist. */
function safeMtimeKey(path: string): string {
  try {
    return String(statSync(path).mtimeMs);
  } catch {
    return "";
  }
}

// ─── Types ──────────────────────────────────────────────────────────────
// Mirrors the JSON Claude Code pipes to the statusLine command (see its
// embedded "How to use the statusLine command" doc). Every block is optional
// in practice — older versions and non-subscriber accounts omit whole trees.

interface RateWindow {
  used_percentage?: number;
  resets_at?: number;
}

interface SpendLimit extends RateWindow {
  /** Spend so far this period, from the gateway's meter. */
  used_usd?: number;
  limit_usd?: number;
  period?: "daily" | "weekly" | "monthly";
}

/**
 * Prompt-cache health for the main conversation, kept by Claude Code's own
 * ledger. Every field below is in the schema embedded in the 2.1.329 binary;
 * older versions send fewer, so each is optional.
 */
export interface PromptCacheInput {
  warm?: boolean;
  caching_observed?: boolean;
  ttl?: "5m" | "1h";
  expires_at?: number | null;
  /** Main-conversation requests this session. */
  requests?: number;
  /** Requests whose cached prefix shrank with no compaction explaining it. */
  misses?: number;
  /** Prefix rebuilds a compaction or tool-result clearing announced. */
  expected_rebuilds?: number;
  /** cache_read / (cache_read + cache_creation + uncached input), 0-1. */
  hit_ratio?: number | null;
  cache_write_tokens?: number;
  /** cache_creation tokens written by the requests counted as misses. */
  miss_recache_tokens?: number;
  last_miss_at?: number | null;
  last_miss_cause?: { causes?: string[] } | null;
  miss_causes?: Record<string, number>;
  recache_tokens_if_cold?: number | null;
}

interface StatuslineInput {
  session_id?: string;
  session_name?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string; git_worktree?: string };
  cost?: {
    total_cost_usd?: number;
    total_duration_ms?: number;
    /** Time the model spent working. */
    total_api_duration_ms?: number;
    total_lines_added?: number;
    total_lines_removed?: number;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    current_usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    } | null;
    used_percentage?: number | null;
    remaining_percentage?: number | null;
  };
  effort?: { level?: string };
  thinking?: { enabled?: boolean };
  rate_limits?: {
    five_hour?: RateWindow;
    seven_day?: RateWindow;
    spend_limit?: SpendLimit;
  };
  prompt_cache?: PromptCacheInput;
  /** Last API call's context passed 200K — long-context pricing on 1M models. */
  exceeds_200k_tokens?: boolean;
  /** Undocumented but emitted by the payload builder in 2.1.274. */
  fast_mode?: boolean;
  pr?: {
    number?: number;
    review_state?: "approved" | "pending" | "changes_requested" | "draft";
    kind?: "mr";
  };
  worktree?: { name?: string };
  /** Set by non-Claude harnesses that reuse this contract (Ribhu sends "ribhu"). */
  agent?: string | { name?: string };
  /**
   * Who picked the model, for harnesses that route (Ribhu via Chitragupta).
   * Proposed contract; absent until the harness sends it.
   */
  route?: {
    via?: string;
    provider?: string;
    model?: string;
    authority?: "kernel" | "fallback" | "pinned";
    offline?: boolean;
    recent_fallbacks?: number;
    recent_total?: number;
  };
}

// ─── View adapters ──────────────────────────────────────────────────────

function shortEffort(level: string): string {
  return level === "medium" ? "med" : level;
}

function rateWindow(w: RateWindow | undefined, spanSec: number): RateWindowView | undefined {
  if (w?.used_percentage === undefined || !Number.isFinite(w.used_percentage)) return undefined;
  return { pct: w.used_percentage, spanSec, ...(w.resets_at ? { resetsAt: w.resets_at } : {}) };
}

const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * The cache segment's numbers, straight from the harness. Nothing is derived:
 * a field the harness didn't send stays absent, and the view leaves it out.
 * No caching observed (off, or a provider that doesn't report it) is no
 * segment at all, not a 0% hit rate.
 */
export function cacheFromInput(pc: PromptCacheInput | undefined): CacheView | undefined {
  if (!pc?.caching_observed) return undefined;
  const causes = pc.last_miss_cause?.causes;
  return {
    warm: typeof pc.warm === "boolean" ? pc.warm : null,
    expiresAt: finite(pc.expires_at) ? pc.expires_at : null,
    rebuildTokens: finite(pc.recache_tokens_if_cold) ? pc.recache_tokens_if_cold : null,
    ...(finite(pc.hit_ratio) ? { hitRatio: pc.hit_ratio } : {}),
    ...(finite(pc.misses) && pc.misses > 0 ? { breaks: pc.misses } : {}),
    ...(finite(pc.miss_recache_tokens) && pc.miss_recache_tokens > 0
      ? { breakTokens: pc.miss_recache_tokens }
      : {}),
    ...(finite(pc.last_miss_at) ? { lastBreakAt: pc.last_miss_at } : {}),
    ...(Array.isArray(causes)
      ? { lastBreakCauses: causes.filter((c): c is string => typeof c === "string") }
      : {}),
  };
}

function spendFromInput(w: SpendLimit | undefined): SpendLimitView | undefined {
  if (!w || !finite(w.used_percentage)) return undefined;
  return {
    pct: w.used_percentage,
    ...(finite(w.resets_at) ? { resetsAt: w.resets_at } : {}),
    // Dollars only as a pair: half of "used of limit" says nothing.
    ...(finite(w.used_usd) && finite(w.limit_usd)
      ? { usedUsd: w.used_usd, limitUsd: w.limit_usd }
      : {}),
    ...(w.period === "daily" || w.period === "weekly" || w.period === "monthly"
      ? { period: w.period }
      : {}),
  };
}

const AUTHORITIES = new Set<string>(["kernel", "fallback", "pinned"]);

export function routeFromInput(input: StatuslineInput): RouteView | undefined {
  const r = input.route;
  if (!r?.via) return undefined;
  return {
    via: r.via,
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.model ? { model: r.model } : {}),
    // The payload is untyped JSON: only a known word reaches the terminal.
    ...(r.authority && AUTHORITIES.has(r.authority) ? { authority: r.authority } : {}),
    ...(r.offline ? { offline: true } : {}),
    ...(finite(r.recent_total) && r.recent_total > 0
      ? {
          recent: {
            fallbacks: finite(r.recent_fallbacks) ? r.recent_fallbacks : 0,
            total: r.recent_total,
          },
        }
      : {}),
  };
}

/** Claude Code sets COLUMNS for the statusline command; keep a small margin. */
function terminalColumns(): number {
  const fromEnv = Number(process.env.COLUMNS);
  const cols = Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : (process.stdout.columns ?? 200);
  // No floor: a narrow terminal gets a clipped line, never one wider than it.
  return Math.max(1, cols - 2);
}

/** A terminal that declares itself dumb gets no color and ASCII glyphs. */
export function isDumbTerminal(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM === "dumb";
}

/**
 * NO_COLOR and a dumb terminal disable color; FORCE_COLOR (anything but "0")
 * re-enables it. cli.ts sets FORCE_COLOR itself for chalk, but only when
 * neither of those asked for plain text.
 */
export function colorEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const force = env.FORCE_COLOR;
  if (force !== undefined) return force !== "0";
  return !env.NO_COLOR && !isDumbTerminal(env);
}

/**
 * "Turns left" before the context fills, from how much the last few turns
 * added. Each upward step in the fill is one turn; a drop of more than 5
 * points is a compaction and starts the history over. Kept per session in
 * the statusline's cache dir, since every render is a fresh process.
 */
export function estimateTurnsLeft(history: number[], pct: number): number | null {
  const steps: number[] = [];
  for (let i = 1; i < history.length; i++) {
    const d = history[i] - history[i - 1];
    if (d > 0) steps.push(d);
  }
  const recent = steps.slice(-5);
  if (recent.length < 2) return null;
  const avg = recent.reduce((a, b) => a + b, 0) / recent.length;
  if (avg <= 0) return null;
  return Math.max(0, Math.floor((100 - pct) / avg));
}

function trackContextTurns(sessionId: string, pct: number): number | null {
  const path = cacheFile(
    `ctx-${createHash("sha256").update(sessionId).digest("hex").slice(0, 16)}.json`
  );
  let history: number[] = [];
  try {
    if (path) history = JSON.parse(readFileSync(path, "utf-8")) as number[];
    if (!Array.isArray(history)) history = [];
  } catch {}
  const last = history[history.length - 1];
  // Most renders repeat the last fill; only a new one is worth a write.
  if (last !== undefined && pct === last) return estimateTurnsLeft(history, pct);
  if (last !== undefined && pct < last - 5) history = [];
  history.push(pct);
  history = history.slice(-8);
  try {
    if (path) writePrivateFile(path, JSON.stringify(history));
  } catch {}
  return estimateTurnsLeft(history, pct);
}

// ─── Animation Engine ────────────────────────────────────────────────────

/** Animation frame (0-7) based on time - 8 frames for smooth animation */
function frame(): number {
  return Math.floor((Date.now() / 200) % 8);
}

/** Heartbeat frames — peak ● lands on frame 3/4, in phase with the logo bg. */
const PULSE = ["○", "◐", "◑", "●", "◑", "◐", "○", "◌"];

/**
 * Brand logo: ♾️ plus a heartbeat.
 *
 * The pill caps ◖ ◗ already frame the bar, so the mark carries no brackets of
 * its own. The dot is signal, not decoration: it pulses through PULSE when the
 * daemon answered this tick (the beat peaks as the violet bg peaks), and sits
 * as a static hollow ○ when the daemon is unreachable.
 *
 * Width-stable: ♾️(2) + space(1) + dot(1) = 4 cells in every frame.
 */
function logoIcon(af: number, alive: boolean): string {
  const dot = alive ? C.accent(PULSE[af]) : C.dim("○");
  return `♾️ ${dot}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Model label. Prefer Claude Code's display_name ("Fable 5.1") over the raw
 * id ("claude-fable-5-1"); fall back to a trimmed id. A `[1m]` suffix (the
 * 1M-context variant) renders as ∞ so the bar shows capability, not a token.
 */
function modelLabel(model: StatuslineInput["model"]): string {
  const raw = model?.display_name || model?.id;
  if (!raw) return "?";
  let name = raw;
  if (name.startsWith("claude-")) name = name.slice(7).replace(/-\d{8}$/, "");
  return name.replace(/\s*\[1m\]$/i, " ∞");
}

async function readStdin(): Promise<string> {
  // If stdin is a TTY (manual run), return empty immediately
  if (process.stdin.isTTY) {
    return "";
  }

  // Otherwise, read from stdin with a timeout
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      resolve(Buffer.concat(chunks).toString("utf-8"));
    }, 100); // 100ms timeout

    process.stdin.on("data", (chunk) => {
      chunks.push(chunk as Buffer);
    });

    process.stdin.on("end", () => {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });

    // Handle case where stdin is available but no events fire
    if (process.stdin.readableEnded) {
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    }
  });
}

interface GitInfo {
  branch: string;
  dirty: number;
}

/**
 * Run git in the session's repo without letting that repo run code or take
 * locks: the cwd is whatever project Claude Code has open, and its
 * .git/config could name an fsmonitor hook that `git status` would execute.
 */
export function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd,
    timeout: 1500,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).toString();
}

/**
 * Get git branch + dirty count for a repo.
 *
 * Cache invalidation is content-aware: we key on the mtime of `.git/HEAD`,
 * which changes on every checkout/commit/rebase. This means a branch
 * switch is reflected instantly (no polling delay) AND we still get the
 * cache hit benefit when nothing changed. TTL is a safety net at 10s.
 *
 * Two git subprocesses would otherwise block the statusline ~50–300ms on a
 * busy repo; the cache cuts that to a single fs read on the hot path.
 */
function getGitInfo(cwd: string): GitInfo | null {
  const headPath = gitHeadPath(cwd);
  // No HEAD, no repo. Skip the cache.
  if (!headPath) return null;

  const headKey = safeMtimeKey(headPath);
  const cachePath = cacheFile(`git-${cwdHash(cwd)}.json`);
  const cached = readCache<GitInfo>(cachePath, 10_000, headKey);
  if (cached) return cached;

  try {
    const branch = runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    let dirty = 0;
    try {
      const status = runGit(cwd, ["status", "--porcelain"]).trim();
      if (status) dirty = status.split("\n").length;
    } catch {}
    const info = { branch, dirty };
    writeCache(cachePath, info, headKey);
    return info;
  } catch {
    return null;
  }
}

/**
 * The HEAD file whose mtime tells one checkout state from the next:
 * `.git/HEAD`, or for a linked worktree (where `.git` is a one-line file
 * naming its git dir) that dir's HEAD. Only ever stat'ed; null when `cwd` is
 * not a repo root.
 */
export function gitHeadPath(cwd: string): string | null {
  const dotGit = join(cwd, ".git");
  try {
    if (statSync(dotGit).isDirectory()) {
      const head = join(dotGit, "HEAD");
      return existsSync(head) ? head : null;
    }
    const match = /^gitdir: (.+)$/m.exec(readFileSync(dotGit, "utf-8").slice(0, 4096));
    if (!match) return null;
    const head = join(resolve(cwd, match[1].trim()), "HEAD");
    return existsSync(head) ? head : null;
  } catch {
    return null;
  }
}

export interface ProjectTotal {
  cost: number;
  in: number;
  out: number;
}

export interface TodayTotals {
  cost: number;
  in: number;
  out: number;
  /** Per-project cost/token totals, keyed by the record's project field. */
  projects: Record<string, ProjectTotal>;
  /** YYYY-MM-DD of when this was computed — invalidates after midnight. */
  day: string;
  /** Epoch ms the daemon computed these totals (absent from older daemons). */
  computedAt?: number;
}

function todayKey(): string {
  return localDateKey();
}

/** Compact age for stale markers: "41s", "3m", "2h". */
export function formatAge(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

/**
 * Today's totals across all providers — READ from the warm daemon, cached 20s.
 *
 * The statusline runs as a fresh subprocess every ~200ms. It must NEVER scan
 * the corpus itself: a full re-parse per tick was ballooning each invocation
 * to ~2GB RSS and stacking faster than they exit (→ kernel panic). The single
 * warm daemon is the source of truth; we just fetch `GET /api/today` (a cheap
 * filtered pass over the daemon's already-loaded records).
 *
 * The 20s file-cache stays as a buffer over the daemon response so most ticks
 * don't even hit the socket. Cache key is the YYYY-MM-DD date AND kosha mtime —
 * midnight rollover and pricing edits both invalidate it on the next pass.
 *
 * Never blank: Claude Code cancels a render that hasn't printed by its next
 * update (~300ms mid-turn). The old 1.5s fetch cap meant 41% of 138 captured
 * renders ran past 1s and showed nothing. So the fetch is capped at
 * DAEMON_FETCH_MS and a miss falls back to the last good totals for today,
 * marked stale with their age so the line never passes them off as live.
 *
 * Only a refused connection means the daemon is down. A slow answer is a busy
 * daemon; starting another one per tick just forks node for nothing. Even a
 * refused start is throttled to once a minute across all statusline processes.
 */
const DAEMON_FETCH_MS = 300;
const DAEMON_SPAWN_THROTTLE_MS = 60_000;
/** Older than this, daemon numbers render dimmed with their age. */
const TODAY_STALE_MS = 30_000;

/** Interactive / multi-CLI flags accepted by `tokmeter-mcp statusline`. */
export interface StatuslineCliOptions {
  ambient: boolean;
  agent?: string;
  cwd?: string;
  style?: StatuslineStyle;
  density?: StatuslineDensity;
  theme?: string;
  format?: StatuslineFormat;
  cols?: number;
  watch: boolean;
  watchMs: number;
  noColor: boolean;
}

const VALID_FORMATS = new Set<string>(["ansi", "tmux", "plain", "title"]);
const VALID_PR_STATES = new Set<string>(["approved", "pending", "changes_requested", "draft"]);

export function parseStatuslineArgs(argv: string[]): StatuslineCliOptions {
  const out: StatuslineCliOptions = {
    ambient: false,
    watch: false,
    watchMs: 2000,
    noColor: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ambient") {
      out.ambient = true;
    } else if (a === "--no-color") {
      out.noColor = true;
    } else if (a === "--watch") {
      out.watch = true;
      out.ambient = true;
      const next = argv[i + 1];
      if (next && /^\d+$/.test(next)) {
        out.watchMs = Math.max(500, Number.parseInt(next, 10));
        i++;
      }
    } else if (a.startsWith("--watch=")) {
      out.watch = true;
      out.ambient = true;
      const n = Number.parseInt(a.slice(8), 10);
      if (Number.isFinite(n) && n > 0) out.watchMs = Math.max(500, n);
    } else if (a === "--agent" && argv[i + 1]) {
      out.agent = argv[++i];
    } else if (a.startsWith("--agent=")) {
      out.agent = a.slice(8);
    } else if (a === "--cwd" && argv[i + 1]) {
      out.cwd = argv[++i];
    } else if (a.startsWith("--cwd=")) {
      out.cwd = a.slice(6);
    } else if (a === "--style" && argv[i + 1]) {
      const val = argv[++i];
      if (STATUSLINE_STYLES.includes(val as StatuslineStyle)) out.style = val as StatuslineStyle;
    } else if (a.startsWith("--style=")) {
      const val = a.slice(8);
      if (STATUSLINE_STYLES.includes(val as StatuslineStyle)) out.style = val as StatuslineStyle;
    } else if (a === "--density" && argv[i + 1]) {
      const val = argv[++i];
      if (STATUSLINE_DENSITIES.includes(val as StatuslineDensity)) {
        out.density = val as StatuslineDensity;
      }
    } else if (a.startsWith("--density=")) {
      const val = a.slice(10);
      if (STATUSLINE_DENSITIES.includes(val as StatuslineDensity)) {
        out.density = val as StatuslineDensity;
      }
    } else if (a === "--theme" && argv[i + 1]) {
      out.theme = argv[++i];
    } else if (a.startsWith("--theme=")) {
      out.theme = a.slice(8);
    } else if (a === "--format" && argv[i + 1]) {
      const val = argv[++i];
      if (VALID_FORMATS.has(val)) out.format = val as StatuslineFormat;
    } else if (a.startsWith("--format=")) {
      const val = a.slice(9);
      if (VALID_FORMATS.has(val)) out.format = val as StatuslineFormat;
    } else if (a === "--cols" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (Number.isFinite(n) && n > 0) out.cols = n;
    } else if (a.startsWith("--cols=")) {
      const n = Number.parseInt(a.slice(7), 10);
      if (Number.isFinite(n) && n > 0) out.cols = n;
    }
  }
  return out;
}

type ContextRead =
  | { state: "fresh" | "stale"; ctx: StatuslineContextResponse; ageMs: number }
  | { state: "down" };

export function readLastGoodToday(path: string): { totals: TodayTotals; ts: number } | null {
  try {
    const wrapper = JSON.parse(readFileSync(path, "utf-8")) as CacheWrapper<TodayTotals>;
    // Any pricing era will do for a dimmed fallback, but never yesterday's day.
    if (wrapper.data?.day !== todayKey()) return null;
    return { totals: wrapper.data, ts: wrapper.data.computedAt ?? wrapper.ts };
  } catch {
    return null;
  }
}

export function isConnectionRefused(err: unknown): boolean {
  const cause = (err as { cause?: { code?: string } })?.cause;
  return cause?.code === "ECONNREFUSED";
}

async function startDaemonThrottled(): Promise<void> {
  const marker = cacheFile("daemon-spawn.at");
  if (!marker) return;
  try {
    if (Date.now() - statSync(marker).mtimeMs < DAEMON_SPAWN_THROTTLE_MS) return;
  } catch {}
  try {
    writePrivateFile(marker, String(Date.now()));
  } catch {
    return;
  }
  try {
    const { spawn } = await import("node:child_process");
    const daemonHeapMb = process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144";
    const child = spawn(process.execPath, [process.argv[1], "daemon", "start"], {
      detached: true,
      stdio: "ignore",
      env: {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${daemonHeapMb}`.trim(),
      },
    });
    child.unref();
  } catch {}
}

function ledgerKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function findProjectTotal(totals: TodayTotals, projectDir: string): ProjectTotal | null {
  if (!projectDir) return null;
  const slug = projectDir.replace(/[^A-Za-z0-9]/g, "-");
  const needles = new Set(
    [canonicalizeProjectName(projectDir, ""), canonicalizeProjectName(slug, "")]
      .map(ledgerKey)
      .filter(Boolean)
  );
  if (needles.size === 0) return null;
  let hit: ProjectTotal | null = null;
  for (const [key, v] of Object.entries(totals.projects)) {
    if (!needles.has(ledgerKey(key))) continue;
    hit = hit ? { cost: hit.cost + v.cost, in: hit.in + v.in, out: hit.out + v.out } : { ...v };
  }
  return hit;
}

function emptyContextFromToday(totals: TodayTotals): StatuslineContextResponse {
  return {
    today: { ...totals, computedAt: totals.computedAt ?? Date.now() },
    repo: null,
    liveSessions: { count: 0, others: [], active: [] },
    paceMultiple: null,
    subagentToday: { cost: 0, share: 0, records: 0 },
    dailyCostThreshold: null,
    unpricedModelsCount: 0,
    quotas: [],
    computedAt: totals.computedAt ?? Date.now(),
  };
}

function readLastGoodContext(
  ctxPath: string | null,
  todayPath: string | null
): { ctx: StatuslineContextResponse; ts: number } | null {
  if (ctxPath) {
    try {
      const wrapper = JSON.parse(
        readFileSync(ctxPath, "utf-8")
      ) as CacheWrapper<StatuslineContextResponse>;
      if (wrapper.data?.today?.day === todayKey()) {
        return { ctx: wrapper.data, ts: wrapper.data.computedAt ?? wrapper.ts };
      }
    } catch {}
  }
  if (todayPath) {
    const legacy = readLastGoodToday(todayPath);
    if (legacy) return { ctx: emptyContextFromToday(legacy.totals), ts: legacy.ts };
  }
  return null;
}

async function getStatuslineContextCached(
  projectDir = "",
  agent?: string,
  skipCache = false
): Promise<ContextRead> {
  const scopeHash = createHash("sha1")
    .update(`${projectDir}|${agent ?? ""}`)
    .digest("hex")
    .slice(0, 10);
  const ctxCachePath = cacheFile(`ctx-world-${scopeHash}.json`);
  const todayCachePath = cacheFile("today.json");
  const contentKey = `${todayKey()}|${getKoshaRegistryMtime()}|${scopeHash}`;
  const now = Date.now();
  if (!skipCache) {
    const cached = readCache<StatuslineContextResponse>(ctxCachePath, 20_000, contentKey);
    if (cached) {
      const ageMs = Math.max(0, now - (cached.computedAt ?? now));
      return { state: ageMs > TODAY_STALE_MS ? "stale" : "fresh", ctx: cached, ageMs };
    }
  }

  const baseUrl = resolveDaemonHttpBase();
  const qs = new URLSearchParams();
  if (projectDir) qs.set("project", projectDir);
  if (agent) qs.set("agent", agent);
  const query = qs.toString() ? `?${qs.toString()}` : "";
  const authorization = readDaemonAuthHeader();

  let refused = false;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), DAEMON_FETCH_MS);
    let ctx: StatuslineContextResponse | null = null;
    try {
      if (authorization) {
        const res = await fetch(`${baseUrl}/api/statusline-context${query}`, {
          signal: ctrl.signal,
          headers: { Authorization: authorization },
        });
        if (res.ok) {
          ctx = (await res.json()) as StatuslineContextResponse;
        } else if (res.status === 404) {
          // Graceful fallback to older daemons serving /api/today only.
          const legacyRes = await fetch(`${baseUrl}/api/today`, {
            signal: ctrl.signal,
            headers: { Authorization: authorization },
          });
          if (legacyRes.ok) {
            ctx = emptyContextFromToday((await legacyRes.json()) as TodayTotals);
          }
        }
      }
    } finally {
      clearTimeout(t);
    }

    if (ctx) {
      writeCache(ctxCachePath, ctx, contentKey);
      writeCache(todayCachePath, ctx.today, `${todayKey()}|${getKoshaRegistryMtime()}`);
      const ageMs = Math.max(0, now - (ctx.computedAt ?? now));
      return { state: ageMs > TODAY_STALE_MS ? "stale" : "fresh", ctx, ageMs };
    }
  } catch (err) {
    refused = isConnectionRefused(err);
  }

  if (refused) await startDaemonThrottled();

  const lastGood = readLastGoodContext(ctxCachePath, todayCachePath);
  if (lastGood) {
    return { state: "stale", ctx: lastGood.ctx, ageMs: Math.max(0, now - lastGood.ts) };
  }
  return { state: "down" };
}

function cleanModelName(raw: string): string {
  let name = raw;
  if (name.startsWith("claude-")) name = name.slice(7).replace(/-\d{8}$/, "");
  return name.replace(/\s*\[1m\]$/i, " ∞");
}

function toRateWindowView(w: QuotaWindow | undefined): RateWindowView | undefined {
  if (!w || w.windowMinutes <= 0) return undefined;
  return {
    pct: w.usedPct,
    spanSec: w.windowMinutes * 60,
    ...(w.resetsAt > 0 ? { resetsAt: w.resetsAt } : {}),
  };
}

/**
 * Build a `StatusView` without stdin for Codex, Gemini, tmux, Zellij, Starship,
 * or `--watch` splits. Combines daemon live sessions, today's totals, git state,
 * and plan quota windows while preserving honest `?` / `~` markers.
 */
export async function buildAmbientStatusView(
  opts: StatuslineCliOptions,
  deps?: {
    homeDir?: string;
    now?: number;
    context?: ContextRead;
  }
): Promise<StatusView> {
  const now = deps?.now ?? Date.now();
  const homeDir = deps?.homeDir ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const folder = cwd.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const shownProject = canonicalizeProjectName(cwd, folder) || folder || "tokmeter";
  const git = cwd ? getGitInfo(cwd) : null;

  const ctxRead = deps?.context ?? (await getStatuslineContextCached(cwd, opts.agent, opts.watch));
  const ctxData = ctxRead.state !== "down" ? ctxRead.ctx : null;
  let quotas: QuotaWindow[] = ctxData?.quotas ?? [];
  if (quotas.length === 0) {
    try {
      quotas = await getQuota(homeDir, now);
    } catch {}
  }

  const sessions = ctxData?.liveSessions.active ?? [];
  const targetSession =
    (opts.agent ? sessions.find((s) => s.provider === opts.agent) : undefined) ?? sessions[0];

  const primaryAgent = opts.agent ?? targetSession?.provider;
  const agentQuotas = primaryAgent ? quotas.filter((q) => q.agent === primaryAgent) : quotas;
  const fiveWin =
    agentQuotas.find((q) => q.window === "5h") ?? quotas.find((q) => q.window === "5h");
  const sevenWin =
    agentQuotas.find((q) => q.window === "7d") ?? quotas.find((q) => q.window === "7d");

  const view: StatusView = {
    now,
    project: shownProject,
    model: targetSession
      ? cleanModelName(targetSession.model)
      : opts.agent
        ? opts.agent
        : "ambient",
    ctx:
      targetSession?.contextFillPct !== undefined
        ? { pct: targetSession.contextFillPct, estimated: true }
        : { pct: null },
    ...(targetSession ? { cost: { usd: targetSession.cost } } : {}),
    ...(toRateWindowView(fiveWin) ? { five: toRateWindowView(fiveWin) } : {}),
    ...(toRateWindowView(sevenWin) ? { seven: toRateWindowView(sevenWin) } : {}),
    today:
      ctxRead.state === "down"
        ? { state: "down" }
        : ctxData && ctxData.today.cost > 0
          ? {
              state: ctxRead.state,
              usd: ctxData.today.cost,
              ageMs: ctxRead.ageMs,
              paceMultiple: ctxData.paceMultiple,
            }
          : { state: "none" },
    ...(git ? { git: { branch: git.branch, dirty: git.dirty } } : {}),
  };

  if (ctxRead.state !== "down" && ctxData) {
    const repoMatch =
      ctxData.repo ??
      (() => {
        const proj = findProjectTotal(ctxData.today, cwd);
        return proj ? { name: shownProject, ...proj } : null;
      })();
    if (repoMatch && repoMatch.cost > 0 && repoMatch.cost < ctxData.today.cost - 0.005) {
      view.repo = { usd: repoMatch.cost, stale: ctxRead.state === "stale" };
    }
    if (ctxData.liveSessions.count > 1) {
      view.liveSessions = {
        count: ctxData.liveSessions.count,
        others: ctxData.liveSessions.others,
      };
    }
    if (ctxData.subagentToday.cost > 0) {
      view.subagentToday = {
        cost: ctxData.subagentToday.cost,
        share: ctxData.subagentToday.share,
        records: ctxData.subagentToday.records,
      };
    }
    if (ctxData.dailyCostThreshold !== null && ctxData.today.cost >= ctxData.dailyCostThreshold) {
      view.budget = {
        dailyThresholdUsd: ctxData.dailyCostThreshold,
        todayUsd: ctxData.today.cost,
      };
    }
    if (ctxData.unpricedModelsCount > 0) {
      view.unpricedModelsCount = ctxData.unpricedModelsCount;
    }
    if (quotas.length > 0) {
      view.quotas = quotas.map((q) => ({
        agent: q.agent,
        label: q.window,
        pct: q.usedPct,
        resetsAt: q.resetsAt,
      }));
    }
  } else if (quotas.length > 0) {
    view.quotas = quotas.map((q) => ({
      agent: q.agent,
      label: q.window,
      pct: q.usedPct,
      resetsAt: q.resetsAt,
    }));
  }

  return view;
}

function resolveRenderOpts(cliOpts: StatuslineCliOptions): {
  cols: number;
  color: boolean;
  ascii: boolean;
  style: StatuslineStyle;
  density: StatuslineDensity;
  theme: string;
  format: StatuslineFormat;
  show: ReturnType<typeof loadConfig>["statusline"]["show"];
} {
  let slConfig: ReturnType<typeof loadConfig>["statusline"] | null = null;
  let rootTheme = "default";
  try {
    const cfg = loadConfig();
    slConfig = cfg.statusline;
    rootTheme = cfg.theme;
  } catch {}
  return {
    cols: cliOpts.cols ?? terminalColumns(),
    color: cliOpts.noColor ? false : colorEnabled(),
    ascii: isDumbTerminal(),
    style: cliOpts.style ?? slConfig?.style ?? "rams",
    density: cliOpts.density ?? slConfig?.density ?? "balanced",
    theme: cliOpts.theme ?? slConfig?.theme ?? rootTheme ?? "default",
    format: cliOpts.format ?? "ansi",
    show: slConfig?.show ?? {
      git: true,
      pr: true,
      cache: true,
      windows: true,
      today: true,
      repo: true,
      pace: true,
      liveSessions: true,
      subagents: true,
      linesDelta: true,
    },
  };
}

// ─── Main ───────────────────────────────────────────────────────────────

export async function runStatusline(argv: string[] = process.argv.slice(3)): Promise<void> {
  const cliOpts = parseStatuslineArgs(argv);
  const renderOpts = resolveRenderOpts(cliOpts);

  if (cliOpts.watch) {
    const renderTick = async () => {
      try {
        const view = await buildAmbientStatusView(cliOpts);
        const out = renderStatusline(view, {
          ...renderOpts,
          cols: cliOpts.cols ?? terminalColumns(),
        });
        if (renderOpts.format === "title") {
          process.stdout.write(out);
        } else if (process.stdout.isTTY) {
          process.stdout.write(`\x1b[2J\x1b[H${out}\n`);
        } else {
          process.stdout.write(`${out}\n`);
        }
      } catch {
        process.stdout.write(`${FALLBACK_STATUSLINE}\n`);
      }
    };
    await renderTick();
    await new Promise<void>((resolveLoop) => {
      const timer = setInterval(() => {
        void renderTick();
      }, cliOpts.watchMs);
      const stop = () => {
        clearInterval(timer);
        resolveLoop();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }

  // Hard watchdog: no matter what hangs below (a stuck daemon fetch, stdin that
  // never closes, a slow import), this process MUST NOT linger and squat RAM.
  // After 4s, exit unconditionally. unref() so it doesn't itself keep the loop
  // alive if everything finished cleanly first.
  const watchdog = setTimeout(() => process.exit(0), 4000);
  watchdog.unref();
  let pendingPush: SessionPush | null = null;

  try {
    if (cliOpts.ambient) {
      const view = await buildAmbientStatusView(cliOpts);
      process.stdout.write(renderStatusline(view, renderOpts));
      return;
    }

    let input: StatuslineInput;

    try {
      const raw = await readStdin();
      input = JSON.parse(raw) as StatuslineInput;
    } catch {
      // If non-ANSI format requested on empty stdin (e.g. tmux/title/plain), fall back to ambient
      if (cliOpts.format && cliOpts.format !== "ansi") {
        const view = await buildAmbientStatusView(cliOpts);
        process.stdout.write(renderStatusline(view, renderOpts));
        return;
      }
      // Animated waiting state
      const f = frame();
      const dots = ".".repeat(f % 4);
      process.stdout.write(
        isDumbTerminal() ? `* waiting${dots}` : `${logoIcon(f, false)} ${C.dim(`waiting${dots}`)}`
      );
      return;
    }

    // ── Gather data ──
    const now = Date.now();
    const projectDir = input.cwd ?? input.workspace?.project_dir ?? "";
    const projectName = projectDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
    // In a worktree the folder is a throwaway name (`agent-a50b…`); show the
    // repo's name, as the ledger counts it, and say it's a worktree.
    const startDir = input.workspace?.project_dir || projectDir;
    const explicitWorktreeName = input.worktree?.name || input.workspace?.git_worktree;
    const inWorktree =
      Boolean(explicitWorktreeName) || /[/\\]\.claude[/\\]worktrees[/\\]/.test(startDir);
    const shownProject = inWorktree ? canonicalizeProjectName(startDir, projectName) : projectName;
    const worktreeTag: boolean | string | undefined =
      typeof explicitWorktreeName === "string" && explicitWorktreeName.trim().length > 0
        ? explicitWorktreeName.trim()
        : inWorktree
          ? true
          : undefined;
    const git = projectDir ? getGitInfo(projectDir) : null;
    const modelId = input.model?.id ?? input.model?.display_name;
    const sessionCost = input.cost?.total_cost_usd ?? 0;
    const durationMs = input.cost?.total_duration_ms ?? 0;
    const activeMs = input.cost?.total_api_duration_ms ?? input.cost?.total_duration_ms;
    const cw = input.context_window;
    const usage = cw?.current_usage ?? null;
    const ctxUsed = cw?.total_input_tokens ?? 0;
    const ctxMax = cw?.context_window_size ?? 0;
    const usedPct = cw?.used_percentage;
    const ctxPct = finite(usedPct)
      ? usedPct
      : finite(ctxMax) && ctxMax > 0 && finite(ctxUsed)
        ? (ctxUsed / ctxMax) * 100
        : null;

    const tokens: TokenUsage = {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    };

    const agentName =
      typeof input.agent === "string"
        ? input.agent
        : typeof input.agent?.name === "string"
          ? input.agent.name
          : "claude-code";

    const contextPromise = getStatuslineContextCached(startDir, agentName).catch(
      (): ContextRead => ({ state: "down" })
    );

    // ── Daemon push: built now, sent only after the line is on stdout ──
    const sessionId = input.session_id ?? `session-${now}`;
    if (input.session_id) {
      const fillUsed =
        finite(ctxMax) && ctxMax > 0 && finite(usedPct)
          ? Math.round((usedPct / 100) * ctxMax)
          : finite(ctxUsed)
            ? ctxUsed
            : 0;
      pendingPush = {
        session: {
          provider: agentName,
          sessionId: input.session_id,
          model: modelId ?? "unknown",
          project: canonicalizeProjectName(input.workspace?.project_dir || projectDir, projectName),
          cwd: projectDir,
          ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}),
        },
        cost: sessionCost,
        tokens,
        durationMs,
        ...(fillUsed > 0 && ctxMax > 0
          ? { contextWindow: { usedTokens: fillUsed, maxTokens: ctxMax } }
          : {}),
      };
    }

    try {
      recordQuotaSamples(homedir(), claudeCodeQuota(input.rate_limits, now));
    } catch {}

    // ── Render ──
    const ctxRead = await contextPromise;
    const ctxData = ctxRead.state !== "down" ? ctxRead.ctx : null;
    const cache = cacheFromInput(input.prompt_cache);
    const spend = spendFromInput(input.rate_limits?.spend_limit);
    const reviewState =
      input.pr?.review_state && VALID_PR_STATES.has(input.pr.review_state)
        ? (input.pr.review_state as PrReviewState)
        : undefined;
    const linesAdded = input.cost?.total_lines_added;
    const linesRemoved = input.cost?.total_lines_removed;
    const hasLinesDelta =
      (finite(linesAdded) && linesAdded > 0) || (finite(linesRemoved) && linesRemoved > 0);
    const hasLastTokens =
      tokens.inputTokens > 0 ||
      tokens.outputTokens > 0 ||
      tokens.cacheReadTokens > 0 ||
      tokens.cacheWriteTokens > 0;

    const view: StatusView = {
      now,
      project: shownProject,
      ...(worktreeTag !== undefined ? { worktree: worktreeTag } : {}),
      model: modelLabel(input.model),
      ...(input.effort?.level ? { effort: shortEffort(input.effort.level) } : {}),
      ...(input.fast_mode === true ? { fastMode: true } : {}),
      ...(routeFromInput(input) ? { route: routeFromInput(input) } : {}),
      ctx: {
        pct: ctxPct,
        ...(ctxMax > 0 ? { windowTokens: ctxMax } : {}),
        turnsLeft: ctxPct === null ? null : trackContextTurns(sessionId, ctxPct),
        ...(input.exceeds_200k_tokens === true ? { exceeds200k: true } : {}),
      },
      ...(cache ? { cache } : {}),
      ...(input.cost
        ? {
            cost: {
              usd: input.cost.total_cost_usd ?? null,
              ...(finite(activeMs) && activeMs > 0 ? { activeMs } : {}),
            },
          }
        : {}),
      ...(rateWindow(input.rate_limits?.five_hour, 5 * 3600)
        ? { five: rateWindow(input.rate_limits?.five_hour, 5 * 3600) }
        : {}),
      ...(rateWindow(input.rate_limits?.seven_day, 7 * 86400)
        ? { seven: rateWindow(input.rate_limits?.seven_day, 7 * 86400) }
        : {}),
      ...(spend ? { spend } : {}),
      today:
        ctxRead.state === "down"
          ? { state: "down" }
          : ctxData && ctxData.today.cost > 0
            ? {
                state: ctxRead.state,
                usd: ctxData.today.cost,
                ageMs: ctxRead.ageMs,
                paceMultiple: ctxData.paceMultiple,
              }
            : { state: "none" },
      ...(git ? { git: { branch: git.branch, dirty: git.dirty } } : {}),
      ...(Number.isSafeInteger(input.pr?.number) && (input.pr?.number ?? 0) > 0
        ? {
            pr: {
              number: input.pr?.number as number,
              ...(reviewState ? { reviewState } : {}),
            },
          }
        : {}),
      ...(hasLinesDelta
        ? {
            linesDelta: {
              added: finite(linesAdded) ? linesAdded : 0,
              removed: finite(linesRemoved) ? linesRemoved : 0,
            },
          }
        : {}),
      ...(hasLastTokens
        ? {
            tokensLast: {
              in: tokens.inputTokens,
              out: tokens.outputTokens,
              cacheRead: tokens.cacheReadTokens,
              cacheWrite: tokens.cacheWriteTokens,
            },
          }
        : {}),
    };
    if (ctxRead.state !== "down" && ctxData) {
      const proj = findProjectTotal(ctxData.today, input.workspace?.project_dir || projectDir);
      if (proj && proj.cost > 0 && proj.cost < ctxData.today.cost - 0.005) {
        view.repo = { usd: proj.cost, stale: ctxRead.state === "stale" };
      }
      if (ctxData.liveSessions.count > 1) {
        view.liveSessions = {
          count: ctxData.liveSessions.count,
          others: ctxData.liveSessions.others,
        };
      }
      if (ctxData.subagentToday.cost > 0) {
        view.subagentToday = {
          cost: ctxData.subagentToday.cost,
          share: ctxData.subagentToday.share,
          records: ctxData.subagentToday.records,
        };
      }
      if (ctxData.dailyCostThreshold !== null && ctxData.today.cost >= ctxData.dailyCostThreshold) {
        view.budget = {
          dailyThresholdUsd: ctxData.dailyCostThreshold,
          todayUsd: ctxData.today.cost,
        };
      }
      if (ctxData.unpricedModelsCount > 0) {
        view.unpricedModelsCount = ctxData.unpricedModelsCount;
      }
      if (ctxData.quotas.length > 0) {
        view.quotas = ctxData.quotas.map((q) => ({
          agent: q.agent,
          label: q.window,
          pct: q.usedPct,
          resetsAt: q.resetsAt,
        }));
      }
    }
    process.stdout.write(renderStatusline(view, renderOpts));
  } catch {
    try {
      process.stdout.write(FALLBACK_STATUSLINE);
    } catch {}
  } finally {
    if (!cliOpts.watch) {
      await afterOutput(pendingPush);
      clearTimeout(watchdog);
      process.exit(0);
    }
  }
}

/** Resolves once stdout has handed everything written so far to the OS. */
function flushStdout(capMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (process.stdout.writableLength === 0) return resolve();
    const timer = setTimeout(resolve, capMs);
    process.stdout.once("drain", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/**
 * The statusline's exit path: the line is already written, so first make sure
 * it has left the process, then tell the daemon this session is live — bounded
 * by PUSH_BUDGET_MS, silent on every failure. Output order is the contract the
 * "never blank" fix depends on: nothing here can delay or replace the line.
 */
export async function afterOutput(
  push: SessionPush | null,
  send: (push: SessionPush) => Promise<boolean> = defaultSend,
  capMs = PUSH_HARD_CAP_MS
): Promise<void> {
  try {
    await flushStdout(500);
  } catch {}
  if (!push) return;
  let capTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      // send may throw synchronously or reject; neither may escape.
      Promise.resolve()
        .then(() => send(push))
        .catch(() => false),
      new Promise<void>((resolve) => {
        capTimer = setTimeout(resolve, capMs);
      }),
    ]);
  } finally {
    clearTimeout(capTimer);
  }
}

/**
 * Outer bound on the push, module load included. pushSessionUpdate holds its
 * own 150 ms budget (PUSH_BUDGET_MS); this only catches what happens before
 * that clock starts.
 */
const PUSH_HARD_CAP_MS = 200;

async function defaultSend(push: SessionPush): Promise<boolean> {
  const { pushSessionUpdate } = await import("./daemon/push.js");
  return pushSessionUpdate(push);
}
