/**
 * @sriinnu/drishti — Claude Code statusline hook handler.
 *
 * Two-line instrument:
 *   line 1 — this session: project · model · context · git · cost, then
 *            live tokens, cache temperature, burn rate, elapsed.
 *   line 2 — the world: subscription windows (5h / 7d), today's cross-provider
 *            spend, this repo's share, concurrent sessions, open PR.
 *
 * Cross-provider aggregation comes from the Drishti Daemon.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { getKoshaRegistryMtime, localDateKey } from "@sriinnu/tokmeter";
import type { DaemonResponse } from "./daemon/client.js";
import type { TokenUsage } from "./daemon/protocol.js";
import {
  C,
  FALLBACK_STATUSLINE,
  formatCost,
  formatDuration,
  formatLineDelta,
  formatNumber,
  formatResetIn,
  formatTierBar,
  powerline,
  segmentColors,
  tierColor,
  useNerdFont,
} from "./formatter.js";
import { monoTheme } from "./typography.js";

// ─── Hot-path caches ────────────────────────────────────────────────────
// The statusline runs as a fresh subprocess every ~200ms. To avoid
// re-doing expensive work (git execSync, full disk scan), we persist
// short-lived results to a per-user cache dir and read them back if fresh.
//
// Per-user dir is critical: a shared /tmp file would leak one user's
// totals to another on multi-user systems. Mode 0700 on the dir.

function getCacheDir(): string {
  let uid = "unknown";
  try {
    uid = String(userInfo().uid);
  } catch {}
  const dir = join(tmpdir(), `drishti-${uid}`);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {}
  }
  return dir;
}

const CACHE_DIR = getCacheDir();

interface CacheWrapper<T> {
  ts: number;
  data: T;
  /** Optional invalidation key — e.g. file mtime — for content-aware caches. */
  key?: string;
}

function readCache<T>(path: string, ttlMs: number, expectedKey?: string): T | null {
  if (!existsSync(path)) return null;
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

function writeCache<T>(path: string, data: T, key?: string): void {
  try {
    const wrapper: CacheWrapper<T> = { ts: Date.now(), data };
    if (key !== undefined) wrapper.key = key;
    writeFileSync(path, JSON.stringify(wrapper), { encoding: "utf-8", mode: 0o600 });
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
    spend_limit?: RateWindow;
  };
  prompt_cache?: {
    warm?: boolean;
    caching_observed?: boolean;
    expires_at?: number | null;
    misses?: number;
    hit_ratio?: number | null;
    recache_tokens_if_cold?: number | null;
  };
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
 * as a static hollow ○ when drishti is unreachable.
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
 * Get git branch + dirty count for a repo.
 *
 * Cache invalidation is content-aware: we key on the mtime of `.git/HEAD`,
 * which changes on every checkout/commit/rebase. This means a branch
 * switch is reflected instantly (no polling delay) AND we still get the
 * cache hit benefit when nothing changed. TTL is a safety net at 10s.
 *
 * Two execSync calls would otherwise block the statusline ~50–300ms on a
 * busy repo; the cache cuts that to a single fs read on the hot path.
 */
function getGitInfo(cwd: string): GitInfo | null {
  const headPath = join(cwd, ".git", "HEAD");
  // If .git/HEAD doesn't exist, we're not in a git repo. Skip the cache.
  if (!existsSync(headPath)) return null;

  const headKey = safeMtimeKey(headPath);
  const cachePath = join(CACHE_DIR, `git-${cwdHash(cwd)}.json`);
  const cached = readCache<GitInfo>(cachePath, 10_000, headKey);
  if (cached) return cached;

  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      timeout: 1500,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    let dirty = 0;
    try {
      const status = execSync("git status --porcelain", {
        cwd,
        timeout: 1500,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (status) dirty = status.split("\n").length;
    } catch {}
    const info = { branch, dirty };
    writeCache(cachePath, info, headKey);
    return info;
  } catch {
    return null;
  }
}

interface ProjectTotal {
  cost: number;
  in: number;
  out: number;
}

interface TodayTotals {
  cost: number;
  in: number;
  out: number;
  /** Per-project cost/token totals, keyed by the record's project field. */
  projects: Record<string, ProjectTotal>;
  /** YYYY-MM-DD of when this was computed — invalidates after midnight. */
  day: string;
}

function todayKey(): string {
  return localDateKey();
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
 * If the daemon is unreachable, we fire-and-forget START it (the cross-process
 * singleton guard prevents dupes) and SKIP the "today" segment for this tick.
 */
async function getTodayTotalsCached(): Promise<TodayTotals | null> {
  const cachePath = join(CACHE_DIR, "today.json");
  const contentKey = `${todayKey()}|${getKoshaRegistryMtime()}`;
  const cached = readCache<TodayTotals>(cachePath, 20_000, contentKey);
  if (cached) return cached;

  const { DAEMON_HOST, DAEMON_PORT } = await import("./daemon/protocol.js");
  const HTTP_PORT = DAEMON_PORT + 1;
  const url = `http://${DAEMON_HOST}:${HTTP_PORT}/api/today`;

  try {
    // Bound the fetch hard — a hung daemon must never hold the hot path open.
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    let totals: TodayTotals | null = null;
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (res.ok) {
        totals = (await res.json()) as TodayTotals;
      }
    } finally {
      clearTimeout(t);
    }

    if (totals) {
      writeCache(cachePath, totals, contentKey);
      return totals;
    }
  } catch {
    // Daemon unreachable — fall through to start it and skip this tick.
  }

  // Daemon not reachable: fire-and-forget start it (detached, heap-capped),
  // then skip the "today" segment for this tick. The singleton guard in the
  // daemon prevents a stampede if many ticks race to start it.
  //
  // Heap cap: the daemon performs the one-time full-history scan, which on a
  // real power-user corpus peaks well past 2GB. We must give it room to warm
  // (a 768MB cap OOM-kills it before it finishes). The statusline's OWN 768MB
  // intent doesn't apply here — this child IS the daemon. Default 6144MB,
  // tunable via TOKMETER_DAEMON_HEAP_MB to match the daemon's own constant.
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

  return null;
}

/**
 * Match the current cwd-derived project name against TodayTotals.projects keys.
 * Parsers store `project` as a flattened path or full path (e.g.
 * `-Users-srinivaspendela-Sriinnu-Personal-tokmeter`); a straightforward
 * case-insensitive suffix/contains match is enough to pin the active project.
 */
function findProjectTotal(totals: TodayTotals, projectName: string): ProjectTotal | null {
  if (!projectName) return null;
  const needle = projectName.toLowerCase();
  // Segment boundary so "app" doesn't claim "-src-webapp".
  const isLastSegment = (k: string) =>
    k === needle || k.endsWith(`-${needle}`) || k.endsWith(`/${needle}`);
  let hit: ProjectTotal | null = null;
  for (const [key, v] of Object.entries(totals.projects)) {
    const k = key.toLowerCase();
    if (isLastSegment(k)) return v;
    if (!hit && (k.includes(`-${needle}-`) || k.includes(`/${needle}/`))) hit = v;
  }
  return hit;
}

/** Filled run in the tier color, empty run dimmed so the segment bg shows through. */
function trackBar(pct: number, color: (s: string) => string): string {
  const { filled, empty } = formatTierBar(pct, 8);
  return color(filled) + C.dim(empty);
}

/**
 * Subscription window: `⏳ 5h ━━━━──── 48% ↻2h10m`. Color follows the usage
 * tier so a window about to throttle reads red at a glance. The reset is
 * relative — "in 2h10m" is what you act on, not a clock time.
 */
function rateWindowSegment(label: string, w: RateWindow | undefined, now: number): string | null {
  const pct = w?.used_percentage;
  if (pct === undefined || !Number.isFinite(pct)) return null;
  const color = tierColor(pct);
  const parts = [C.dim(label), trackBar(pct, color), color(`${Math.round(pct)}%`)];
  const reset = w?.resets_at ? formatResetIn(w.resets_at, now) : "";
  if (reset) parts.push(C.dim(`↻${reset}`));
  return parts.join(" ");
}

/**
 * Cache temperature. Warm: hit ratio + minutes until the cached prefix goes
 * cold — the one number that tells you "reply now or re-cache 180K". Cold:
 * how much the next request will re-cache. Misses are diagnosed by Claude
 * Code itself (tools changed, system prompt changed…); we just count them.
 */
function cacheSegment(pc: StatuslineInput["prompt_cache"], now: number): string | null {
  if (!pc || pc.caching_observed === false) return null;
  const bolt = "↯";
  const parts: string[] = [];
  if (pc.warm) {
    const ratio = pc.hit_ratio;
    const pctText = ratio !== null && ratio !== undefined ? `${Math.round(ratio * 100)}%` : "warm";
    parts.push(C.accent(`${bolt}${pctText}`));
    if (pc.expires_at) {
      const left = formatResetIn(pc.expires_at, now);
      if (left) parts.push(C.dim(left));
    }
  } else {
    parts.push(C.danger(`${bolt}cold`));
    if (pc.recache_tokens_if_cold) {
      parts.push(C.dim(`≈${formatNumber(pc.recache_tokens_if_cold)}`));
    }
  }
  if (pc.misses && pc.misses > 0) parts.push(C.warn(`✗${pc.misses}`));
  return parts.join(" ");
}

const PR_STATE_GLYPH: Record<string, (s: string) => string> = {
  approved: (s) => C.accent(`${s} ✓`),
  changes_requested: (s) => C.danger(`${s} ✗`),
  draft: (s) => C.dim(`${s} ◌`),
  pending: (s) => C.warn(`${s} ○`),
};

function prSegment(pr: StatuslineInput["pr"]): string | null {
  if (!pr?.number) return null;
  const ref = `⇄${pr.kind === "mr" ? "!" : "#"}${pr.number}`;
  const paint = pr.review_state ? PR_STATE_GLYPH[pr.review_state] : undefined;
  return paint ? paint(ref) : C.dim(ref);
}

// ─── Main ───────────────────────────────────────────────────────────────

export async function runStatusline(): Promise<void> {
  // Hard watchdog: no matter what hangs below (a stuck daemon fetch, stdin that
  // never closes, a slow import), this process MUST NOT linger and squat RAM.
  // After 4s, exit unconditionally. unref() so it doesn't itself keep the loop
  // alive if everything finished cleanly first.
  const watchdog = setTimeout(() => process.exit(0), 4000);
  watchdog.unref();

  try {
    let input: StatuslineInput;

    try {
      const raw = await readStdin();
      input = JSON.parse(raw) as StatuslineInput;
    } catch {
      // Animated waiting state
      const f = frame();
      const dots = ".".repeat(f % 4);
      process.stdout.write(`${logoIcon(f, false)} ${C.dim(`waiting${dots}`)}`);
      return;
    }

    // ── Gather data ──
    const now = Date.now();
    const projectDir = input.cwd ?? input.workspace?.project_dir ?? "";
    const projectName = projectDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
    const git = projectDir ? getGitInfo(projectDir) : null;
    const modelId = input.model?.id ?? input.model?.display_name;
    const sessionCost = input.cost?.total_cost_usd ?? 0;
    const durationMs = input.cost?.total_duration_ms ?? 0;
    const cw = input.context_window;
    const usage = cw?.current_usage ?? null;
    const ctxUsed = cw?.total_input_tokens ?? 0;
    const ctxMax = cw?.context_window_size ?? 0;
    // Claude Code pre-computes the fill against its effective window; trust it
    // over our own ratio when present (their number is what triggers compaction).
    const ctxPct =
      cw?.used_percentage !== null && cw?.used_percentage !== undefined
        ? cw.used_percentage
        : ctxMax > 0
          ? (ctxUsed / ctxMax) * 100
          : null;

    // Last API call's usage — the payload carries no session-cumulative token
    // counts, so this is the honest live signal we can give the daemon.
    const tokens: TokenUsage = {
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    };

    // ── Daemon sync (background, non-blocking) ──
    const sessionId = input.session_id ?? `session-${now}`;
    let daemonResponse: DaemonResponse = { connected: false };
    try {
      const { syncUpdate } = await import("./daemon/client.js");
      daemonResponse = await syncUpdate(
        {
          provider: "claude-code",
          sessionId,
          model: modelId ?? "unknown",
          project: projectName,
          cwd: projectDir,
          // Lets the daemon answer with this session's ledger totals — the
          // payload itself never carries session-cumulative tokens.
          ...(input.transcript_path ? { transcriptPath: input.transcript_path } : {}),
        },
        sessionCost,
        tokens,
        durationMs,
        // Live context-window occupancy — only when Claude Code reports both a
        // used-token count and a window size, so the daemon never derives a
        // fill % from partial data.
        ctxUsed > 0 && ctxMax > 0 ? { usedTokens: ctxUsed, maxTokens: ctxMax } : undefined
      );
    } catch {}

    // ── Build Powerline Segments ──
    // One clean bar — no duplication. Each segment = one piece of info.
    const seg = segmentColors();
    const pl: { text: string; bg: string }[] = [];

    // Icon sets — Nerd Font (opt-in) or animated Unicode (default, works everywhere)
    // Each icon is an 8-frame animation array. frame() cycles 0-7 at ~200ms, so
    // each statusline invocation picks a different frame — creating the shimmer.
    const nf = useNerdFont();
    const af = frame(); // animation frame for icon cycling

    const ICON = nf
      ? {
          infinity: logoIcon(af, daemonResponse.connected),
          agent: "󰵰", // 󰍰 nf-md-robot
          git: "", //  nf-fa-git
          turn: "", //  nf-fa-level_up
          context: "󰍛", // 󰍛 nf-md-memory
          folder: "󰣞", // 󰳞 nf-md-folder
          dollar: "", //  nf-fa-dollar
          flame: "", //  nf-oct-flame
          up: "", //  nf-fa-arrow_up
          down: "", //  nf-fa-arrow_down
          refresh: "", //  nf-fa-refresh
          hourglass: "", //  nf-fa-hourglass_half
          worktree: "", //  nf-fa-code_fork
        }
      : {
          // Disney pixel animation: width-stable, anchored, no horizontal jitter.
          //
          // Width-stability rules:
          //   - Every animation frame must occupy the same number of terminal cells.
          //   - Emoji are width-2 (sometimes 1 on legacy terminals); when paired
          //     with text characters, the total width can shift. We avoid mixing.
          infinity: logoIcon(af, daemonResponse.connected),
          // Emoji only where the emoji IS the meaning (branch, burn, window,
          // brand). Everything else is a 1-cell text glyph: ✏ and ⚡ are
          // emoji-presentation (2 cells) while ✎ and ↯ are text (1 cell), so
          // alternating them jittered the whole bar every frame.
          agent: "",
          git: "🌿",
          turn: "✎",
          context: "",
          folder: "",
          dollar: "",
          flame: "🔥",
          up: ["↑", "↑", "↑", "↗", "↑", "↑", "↑", "↗"][af],
          down: ["↓", "↓", "↓", "↘", "↓", "↓", "↓", "↘"][af],
          refresh: ["⟳", "↻", "⟳", "↺", "⟳", "↻", "⟳", "↺"][af],
          // Sand runs for 4 frames, flips for 4 — both glyphs are width-2 emoji.
          hourglass: af < 4 ? "⏳" : "⌛",
          worktree: "⎇",
        };

    // Hero logo bg: breathes through purple shades (indigo → violet → magenta → back).
    // Asymmetric timing — slow rise (frames 0-3), peak (4), slow fall (5-7).
    const logoBgCycle = [
      "#4338ca", // indigo (rest)
      "#5b21b6", // deep violet
      "#6d28d9", // violet
      "#7c3aed", // bright violet
      "#8b5cf6", // peak — radiant violet
      "#7c3aed", // bright violet
      "#6d28d9", // violet
      "#5b21b6", // deep violet
    ];
    const logoBg = logoBgCycle[af];

    // Helper: prefix icon only if non-empty
    const ic = (icon: string, text: string) => (icon ? `${icon} ${text}` : text);

    // 1. Logo + daemon heartbeat — its own segment with breathing purple bg cycle
    pl.push({ text: ICON.infinity, bg: logoBg });

    // 2. Project (+ worktree). Truncate long names so the bar doesn't wrap on
    // 80-col terms.
    if (projectName) {
      const trunc = projectName.length > 24 ? `${projectName.slice(0, 23)}…` : projectName;
      const wt = input.worktree?.name ?? input.workspace?.git_worktree;
      const wtText = wt ? ` ${ICON.worktree}${wt}` : "";
      pl.push({ text: ic(ICON.folder, monoTheme.name(trunc) + wtText), bg: seg.project });
    }

    // 3. Model — display name, ∞ for 1M windows, then the reasoning posture:
    // ∴ (therefore) when extended thinking is on, effort level when reported.
    if (modelId) {
      let label = modelLabel(input.model);
      if (ctxMax >= 900_000 && !label.includes("∞")) label += " ∞";
      const effort = input.effort?.level;
      const think = input.thinking?.enabled ? "∴" : effort ? "·" : "";
      const posture = think ? ` ${think}${effort ?? ""}` : "";
      const fast = input.fast_mode ? " »" : "";
      pl.push({ text: ic(ICON.agent, `${label}${posture}${fast}`), bg: seg.model });
    }

    // 4. Context — tiered fill: calm → amber → red as compaction nears.
    if (ctxPct !== null) {
      const color = tierColor(ctxPct);
      const bar = trackBar(ctxPct, color);
      // Past 200K the 1M-window models bill at the long-context rate.
      const over = input.exceeds_200k_tokens ? C.warn(" 200K+") : "";
      pl.push({
        text: ic(ICON.context, `${bar} ${color(`${Math.round(ctxPct)}%`)}${over}`),
        bg: seg.context,
      });
    }

    // 5. Git — branch, dirty count, and the session's line delta.
    if (git) {
      const dirty = git.dirty > 0 ? ` ${ICON.turn}${git.dirty}` : "";
      const delta = formatLineDelta(
        input.cost?.total_lines_added ?? 0,
        input.cost?.total_lines_removed ?? 0
      );
      const deltaText = delta
        ? ` ${C.accent(delta.added)}${delta.added && delta.removed ? " " : ""}${C.danger(delta.removed)}`
        : "";
      pl.push({ text: `${ICON.git} ${git.branch}${dirty}${deltaText}`, bg: seg.git });
    }

    // 6. Cost
    if (sessionCost > 0) {
      pl.push({ text: ic(ICON.dollar, formatCost(sessionCost)), bg: seg.cost });
    }

    // ── Line 1 suffix: this session, live ──
    const session: string[] = [];

    // Session burn. Σ = ledger totals the daemon summed from this session's
    // transcript (the honest cumulative). Without a daemon answer, fall back
    // to the last API call's usage — still real, just not cumulative.
    const ledger = daemonResponse.yourSession?.ledger;
    if (ledger) {
      const tParts = [
        C.input(`${ICON.up}${formatNumber(ledger.inputTokens)}`),
        C.output(`${ICON.down}${formatNumber(ledger.outputTokens)}`),
      ];
      const cached = ledger.cacheReadTokens + ledger.cacheWriteTokens;
      if (cached > 0) tParts.push(C.cache(`${ICON.refresh}${formatNumber(cached)}`));
      if (ledger.reasoningTokens > 0)
        tParts.push(C.think(`∴${formatNumber(ledger.reasoningTokens)}`));
      session.push(`${C.dim("Σ")}${tParts.join(" ")}`);
    } else if (usage) {
      const tParts: string[] = [];
      if (usage.input_tokens) tParts.push(C.input(`${ICON.up}${formatNumber(usage.input_tokens)}`));
      if (usage.output_tokens)
        tParts.push(C.output(`${ICON.down}${formatNumber(usage.output_tokens)}`));
      if (usage.cache_read_input_tokens)
        tParts.push(C.cache(`${ICON.refresh}${formatNumber(usage.cache_read_input_tokens)}`));
      if (tParts.length > 0) session.push(tParts.join(" "));
    }

    const cache = cacheSegment(input.prompt_cache, now);
    if (cache) session.push(cache);

    // Burn rate
    if (durationMs > 60_000 && sessionCost > 0) {
      const rate = sessionCost / (durationMs / 3_600_000);
      session.push(C.warn(`${ICON.flame}${formatCost(rate)}/hr`));
    }

    if (durationMs > 60_000) session.push(C.dim(formatDuration(durationMs)));

    // ── Line 2: the world outside this session ──
    const world: string[] = [];

    const rl = input.rate_limits;
    if (rl) {
      const five = rateWindowSegment("5h", rl.five_hour, now);
      const week = rateWindowSegment("7d", rl.seven_day, now);
      const spend = rateWindowSegment("$", rl.spend_limit, now);
      const windows = [five, week, spend].filter((s): s is string => s !== null);
      if (windows.length > 0) world.push(`${ICON.hourglass} ${windows.join(`  ${C.dim("·")}  `)}`);
    }

    // Today's totals — cross-provider roll-up across Claude Code, Codex, Qwen,
    // etc., for the local calendar day. Cache resets at midnight via dayKey.
    const today = await getTodayTotalsCached();
    if (today && today.cost > 0) {
      world.push(
        `${C.accent(monoTheme.ephemeral("today"))} ${C.cost(formatCost(today.cost))} ${C.input(`${ICON.up}${formatNumber(today.in)}`)} ${C.output(`${ICON.down}${formatNumber(today.out)}`)}`
      );
      // Project roll-up — only show when it's a meaningful subset of today's
      // total (not identical to the day total, not zero). Gives you "what has
      // this repo cost me today" across every model you ran against it.
      const proj = findProjectTotal(today, projectName);
      if (proj && proj.cost > 0 && proj.cost < today.cost - 0.005) {
        world.push(
          `${C.accent(monoTheme.ephemeral("proj"))} ${C.cost(formatCost(proj.cost))} ${C.input(`${ICON.up}${formatNumber(proj.in)}`)} ${C.output(`${ICON.down}${formatNumber(proj.out)}`)}`
        );
      }
    }

    // Concurrent sessions across every tracked agent.
    if (daemonResponse.connected && daemonResponse.aggregated) {
      const agg = daemonResponse.aggregated;
      if (agg.sessions > 1) world.push(`${C.title("⊕")}${C.dim(`${agg.sessions} live`)}`);
    }

    const pr = prSegment(input.pr);
    if (pr) world.push(pr);

    // ── Output: powerline bar + session suffix, then the world line ──
    const sep = ` ${C.dim("│")} `;
    const line1 = powerline(pl) + (session.length > 0 ? ` ${session.join(sep)}` : "");
    const out = world.length > 0 ? `${line1}\n${world.join(sep)}` : line1;
    process.stdout.write(out);
  } catch {
    // Nuclear fallback — if ANYTHING above threw, still produce output
    try {
      process.stdout.write(FALLBACK_STATUSLINE);
    } catch {}
  } finally {
    // ALWAYS exit promptly once output is written. A backgrounded daemon
    // fire-and-forget spawn or a lingering socket handle could otherwise keep
    // the event loop alive and leave an orphan squatting RAM — the exact
    // failure mode that stacked into a kernel panic. Flush, then exit.
    clearTimeout(watchdog);
    const done = () => process.exit(0);
    if (process.stdout.writableLength > 0) {
      process.stdout.once("drain", done);
      // Belt-and-suspenders: if drain never fires, the watchdog already
      // unref'd would normally cover it, but it's been cleared — so guard
      // with a short timer too.
      setTimeout(done, 500).unref();
    } else {
      done();
    }
  }
}
