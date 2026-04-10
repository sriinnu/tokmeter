/**
 * @sriinnu/drishti — Claude Code statusline hook handler.
 *
 * Innovative, animated statusline with particle effects, gradients,
 * and real-time visualizations for the "wow" factor.
 *
 * Now supports cross-provider aggregation via the Drishti Daemon!
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { localDateKey } from "@sriinnu/tokmeter-core";
import type { DaemonResponse } from "./daemon/client.js";
import type { TokenUsage } from "./daemon/protocol.js";
import {
  C,
  FALLBACK_STATUSLINE,
  formatCost,
  formatNumber,
  formatPercent,
  powerline,
  segmentColors,
  useNerdFont,
} from "./formatter.js";
import { defaultTheme, italicMath } from "./typography.js";

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

interface StatuslineInput {
  session_id?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  token_counts?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}

// ─── Animation Engine ────────────────────────────────────────────────────

/** Animation frame (0-7) based on time - 8 frames for smooth animation */
function frame(): number {
  return Math.floor((Date.now() / 200) % 8);
}

/** Particle effects — only pulse is used (agent activity dot). */
const PARTICLES = {
  pulse: ["○", "◐", "◑", "●", "◑", "◐", "○", "◌"],
};

/** Cache hit rate with color-coded efficiency indicator */
function animCacheRate(cacheRead: number, cacheWrite: number): string {
  const total = cacheRead + cacheWrite;
  if (total <= 0) return "";

  const rate = (cacheRead / total) * 100;
  if (!Number.isFinite(rate)) return "";

  const f = frame();
  const icons = ["⚡", "↯", "⚡", "↯", "⚡", "↯", "⚡", "↯"];
  const icon = icons[f];

  // Green >80%, yellow 50-80%, red <50%
  const colorFn = rate > 80 ? C.accent : rate >= 50 ? C.warn : C.danger;
  return colorFn(`${icon}${formatPercent(rate)}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────

/** Compact context bar for powerline segment: ▓▓▓▓░░░░ */
function formatContextMini(used: number, max: number): string {
  if (!(max > 0)) return "";
  const w = 8;
  // Clamp pct to [0, 1] so over-budget contexts don't crash .repeat() with a
  // negative count. This happens when a tool reports more used than the
  // window size (e.g. mid-conversation context measurement).
  const pct = Math.max(0, Math.min(1, used / max));
  const filled = Math.round(pct * w);
  return "▓".repeat(filled) + "░".repeat(w - filled);
}

function shortModelName(id: string | undefined): string {
  if (!id) return "?";
  let name = id;
  if (name.startsWith("claude-")) name = name.slice(7);
  name = name.replace(/-\d{8}$/, "");
  return name;
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

interface TodayTotals {
  cost: number;
  in: number;
  out: number;
  /** YYYY-MM-DD of when this was computed — invalidates after midnight. */
  day: string;
}

function todayKey(): string {
  return localDateKey();
}

/**
 * Today's totals across all providers, cached for 60s.
 *
 * Cache key is the YYYY-MM-DD date — at midnight rollover the cache is
 * invalidated automatically so yesterday's number doesn't linger as
 * "today's." TTL is the secondary defense for intra-day refresh.
 *
 * Fetching fresh requires a full disk scan which costs hundreds of ms on
 * power users — utterly unacceptable for a 200ms hot path. The 60s TTL
 * means today's number lags reality by up to a minute, which is fine
 * for an at-a-glance display.
 */
async function getTodayTotalsCached(): Promise<TodayTotals | null> {
  const cachePath = join(CACHE_DIR, "today.json");
  const dayKey = todayKey();
  const cached = readCache<TodayTotals>(cachePath, 60_000, dayKey);
  if (cached) return cached;

  try {
    const { TokmeterCore } = await import("@sriinnu/tokmeter-core");
    const core = new TokmeterCore();
    const records = await core.scan({ today: true });
    let cost = 0;
    let inT = 0;
    let outT = 0;
    for (const r of records) {
      cost += r.cost;
      inT += r.inputTokens;
      outT += r.outputTokens;
    }
    const totals: TodayTotals = { cost, in: inT, out: outT, day: dayKey };
    writeCache(cachePath, totals, dayKey);
    return totals;
  } catch {
    return null;
  }
}

// ─── Main ───────────────────────────────────────────────────────────────

export async function runStatusline(): Promise<void> {
  try {
    let input: StatuslineInput;

    try {
      const raw = await readStdin();
      input = JSON.parse(raw) as StatuslineInput;
    } catch {
      // Animated waiting state
      const f = frame();
      const dots = ".".repeat(f % 4);
      process.stdout.write(
        `${C.title("【♾️】")} ${C.accent(PARTICLES.pulse[f])}${C.dim(`waiting${dots}`)}`
      );
      return;
    }

    // ── Gather data ──
    const projectDir = input.cwd ?? input.workspace?.project_dir ?? "";
    const projectName = projectDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
    const git = projectDir ? getGitInfo(projectDir) : null;
    const modelId = input.model?.id ?? input.model?.display_name;
    const sessionCost = input.cost?.total_cost_usd ?? 0;
    const durationMs = input.cost?.total_duration_ms ?? 0;
    const tc = input.token_counts;
    const ctxUsed = input.context_window?.total_input_tokens ?? 0;
    const ctxMax = input.context_window?.context_window_size ?? 0;

    const tokens: TokenUsage = {
      inputTokens: tc?.input_tokens ?? 0,
      outputTokens: tc?.output_tokens ?? 0,
      cacheReadTokens: tc?.cache_read_tokens ?? 0,
      cacheWriteTokens: tc?.cache_write_tokens ?? 0,
    };

    // ── Daemon sync (background, non-blocking) ──
    const sessionId = input.session_id ?? `session-${Date.now()}`;
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
        },
        sessionCost,
        tokens,
        durationMs
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
          infinity: "【♾️】",
          agent: "\uDB83\uDD70", // 󰍰 nf-md-robot
          git: "\uF113", //  nf-fa-git
          turn: "\uF148", //  nf-fa-level_up
          context: "\uDB80\uDF5B", // 󰍛 nf-md-memory
          folder: "\uDB82\uDCDE", // 󰳞 nf-md-folder
          dollar: "\uF155", //  nf-fa-dollar
          flame: "\uF490", //  nf-oct-flame
          up: "\uF062", //  nf-fa-arrow_up
          down: "\uF063", //  nf-fa-arrow_down
          refresh: "\uF021", //  nf-fa-refresh
          bolt: "\uF0E7", //  nf-fa-bolt
          calendar: "\uF073", //  nf-fa-calendar
        }
      : {
          // Disney pixel animation: width-stable, anchored, no horizontal jitter.
          //
          // Width-stability rules:
          //   - Every animation frame must occupy the same number of terminal cells.
          //   - Emoji are width-2 (sometimes 1 on legacy terminals); when paired
          //     with text characters, the total width can shift. We avoid mixing.
          //   - Sparkle accents use the same emoji-style chars as the base so the
          //     trailing slot stays width-2 in every frame.
          //
          // Logo: ♾️ anchored at left; the trailing slot animates between sparkle
          // emoji. The infinity NEVER shifts position — only the trailing accent
          // changes. (No more leading-space frames that shift the whole logo.)
          infinity: ["♾️✦", "♾️✧", "♾️✦", "♾️✧", "♾️✦", "♾️✧", "♾️✦", "♾️✧"][af],
          // The Genie — both frames are width-stable (genie + sparkle emoji slot).
          // Frame 0: genie + invisible joiner (width 2 + 1)
          // Frame 1: genie + sparkle (width 2 + 1)
          // Both slots are exactly 1 visual cell wide.
          agent: ["🧞", "🧞", "🧞", "🧞", "🧞", "🧞", "🧞", "🧞"][af],
          git: "🌿",
          turn: ["✎", "✏", "✎", "✏", "✎", "✏", "✎", "✏"][af],
          context: "",
          folder: "",
          dollar: "💰",
          flame: "🔥",
          // Token arrows: stick to 1-cell text chars (no emoji ⬆⬇ which cause jitter).
          up: ["↑", "↑", "↑", "↗", "↑", "↑", "↑", "↗"][af],
          down: ["↓", "↓", "↓", "↘", "↓", "↓", "↓", "↘"][af],
          refresh: ["⟳", "↻", "⟳", "↺", "⟳", "↻", "⟳", "↺"][af],
          bolt: ["⚡", "↯", "⚡", "↯", "⚡", "↯", "⚡", "↯"][af],
          calendar: "",
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

    // 1. Logo — its own segment with breathing purple bg cycle
    pl.push({ text: ICON.infinity, bg: logoBg });

    // 2. Project — small caps typography (Pixar-magazine type system).
    // Truncate long names so the bar doesn't wrap on 80-col terms.
    if (projectName) {
      const trunc = projectName.length > 24 ? `${projectName.slice(0, 23)}…` : projectName;
      pl.push({ text: ic(ICON.folder, defaultTheme.name(trunc)), bg: seg.project });
    }

    // 3. Model / Agent — pulsing activity indicator
    if (modelId) {
      pl.push({ text: `${ICON.agent} ${shortModelName(modelId)}`, bg: seg.model });
    }

    // 4. Context — bar speaks for itself, no redundant icon needed
    if (ctxMax > 0) {
      const pctLeft = Math.max(0, 100 - (ctxUsed / ctxMax) * 100);
      const ctxBar = formatContextMini(ctxUsed, ctxMax);
      pl.push({ text: ic(ICON.context, `${ctxBar} ${pctLeft.toFixed(1)}% left`), bg: seg.context });
    }

    // 5. Git —  git icon (like Codex)
    if (git) {
      const dirty = git.dirty > 0 ? ` ${ICON.turn}${git.dirty}` : "";
      pl.push({ text: `${ICON.git} ${git.branch}${dirty}`, bg: seg.git });
    }

    // 6. Cost
    if (sessionCost > 0) {
      pl.push({ text: `${ICON.dollar} ${formatCost(sessionCost)}`, bg: seg.cost });
    }

    // ── Suffix: token flow + extras (plain text after powerline) ──
    const suffix: string[] = [];

    // Token flow with Nerd Font arrows
    if (tc) {
      const tParts: string[] = [];
      if (tc.input_tokens) tParts.push(C.input(`${ICON.up}${formatNumber(tc.input_tokens)}`));
      if (tc.output_tokens) tParts.push(C.output(`${ICON.down}${formatNumber(tc.output_tokens)}`));
      const cacheTotal = (tc.cache_read_tokens ?? 0) + (tc.cache_write_tokens ?? 0);
      if (cacheTotal > 0) tParts.push(C.cache(`${ICON.refresh}${formatNumber(cacheTotal)}`));
      if (tParts.length > 0) suffix.push(tParts.join(" "));

      // Cache hit rate
      const cacheRate = animCacheRate(tc.cache_read_tokens ?? 0, tc.cache_write_tokens ?? 0);
      if (cacheRate) suffix.push(cacheRate);
    }

    // Burn rate
    if (durationMs > 60_000 && sessionCost > 0) {
      const rate = sessionCost / (durationMs / 3_600_000);
      suffix.push(C.warn(`${ICON.flame}${formatCost(rate)}/hr`));
    }

    // Daemon aggregated stats — only if daemon is reachable AND has data.
    let showedAggregated = false;
    if (daemonResponse.connected && daemonResponse.aggregated) {
      const agg = daemonResponse.aggregated;
      if (agg.sessions > 1) {
        suffix.push(
          `${C.title("⊕")}${C.cost(formatCost(agg.totalCost))} ${C.input(`${ICON.up}${formatNumber(agg.totalInputTokens)}`)} ${C.output(`${ICON.down}${formatNumber(agg.totalOutputTokens)}`)}`
        );
        showedAggregated = true;
      }
    }

    // Today's totals — cached for 60s so we don't full-scan every 200ms.
    // Only fetch when we didn't already show aggregated multi-session data.
    if (!showedAggregated) {
      const today = await getTodayTotalsCached();
      if (today && today.cost > 0) {
        // "today" in italic math — ephemeral typography for transient data
        suffix.push(
          `${C.accent(italicMath("today"))} ${C.cost(formatCost(today.cost))} ${C.dim("│")} ${C.input(`${ICON.up}${formatNumber(today.in)}`)} ${C.output(`${ICON.down}${formatNumber(today.out)}`)}`
        );
      }
    }

    // ── Output: powerline bar + suffix ──
    const bar = powerline(pl);
    const trail = suffix.length > 0 ? ` ${suffix.join(` ${C.dim("│")} `)}` : "";
    process.stdout.write(bar + trail);
  } catch {
    // Nuclear fallback — if ANYTHING above threw, still produce output
    try {
      process.stdout.write(FALLBACK_STATUSLINE);
    } catch {}
  }
}
