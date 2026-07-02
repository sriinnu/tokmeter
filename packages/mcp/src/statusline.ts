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
import { getKoshaRegistryMtime, localDateKey } from "@sriinnu/tokmeter";
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

/**
 * Brand logo: bracket-framed emoji infinity with shimmer accents.
 *
 * Single ♾️ emoji at center — emojis render at the cell's full visual bounds
 * (≈2 cells wide, rich color/weight), structurally thicker than the thin
 * text-presentation ∞. Fullwidth brackets ［ ］ (U+FF3B/U+FF3D, 2 cells each)
 * frame it with matching heft. Sparkles ✦/✧ on each side swap per frame for
 * a gentle shimmer halo.
 *
 * The breathing violet bg cycle still runs underneath. The emoji carries its
 * own color from the system emoji font; the sparkles take chalk's white-bold
 * from segmentBody and pop against the violet.
 *
 * Width-stable across frames: ［(2) + space(1) + ✦(1) + space(1) + ♾️(2) +
 * space(1) + ✧(1) + space(1) + ］(2) = 12 cells.
 */
const LOGO_SPARKLES = ["✦", "✧"];

function logoIcon(af: number): string {
  const sparkLeft = LOGO_SPARKLES[af % 2];
  const sparkRight = LOGO_SPARKLES[(af + 1) % 2];
  return `［ ${sparkLeft} ♾️ ${sparkRight} ］`;
}

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
  // Claude Code tags 1M-context variants as `...[1m]` — render as ∞ so the
  // bar shows the capability instead of an opaque square token.
  name = name.replace(/\[1m\]$/i, " ∞");
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
 * Today's totals across all providers — READ from the warm daemon, cached 60s.
 *
 * The statusline runs as a fresh subprocess every ~200ms. It must NEVER scan
 * the corpus itself: a full re-parse per tick was ballooning each invocation
 * to ~2GB RSS and stacking faster than they exit (→ kernel panic). The single
 * warm daemon is the source of truth; we just fetch `GET /api/today` (a cheap
 * filtered pass over the daemon's already-loaded records).
 *
 * The 60s file-cache stays as a buffer over the daemon response so most ticks
 * don't even hit the socket. Cache key is the YYYY-MM-DD date AND kosha mtime —
 * midnight rollover and pricing edits both invalidate it on the next pass.
 *
 * If the daemon is unreachable, we fire-and-forget START it (the cross-process
 * singleton guard prevents dupes) and SKIP the "today" segment for this tick.
 */
async function getTodayTotalsCached(): Promise<TodayTotals | null> {
  const cachePath = join(CACHE_DIR, "today.json");
  const contentKey = `${todayKey()}|${getKoshaRegistryMtime()}`;
  const cached = readCache<TodayTotals>(cachePath, 60_000, contentKey);
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
  let hit: ProjectTotal | null = null;
  for (const [key, v] of Object.entries(totals.projects)) {
    const k = key.toLowerCase();
    if (k === needle || k.endsWith(needle) || k.includes(needle)) {
      // Prefer the strongest match if multiple keys hit.
      if (!hit || k.endsWith(needle)) hit = v;
    }
  }
  return hit;
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
      process.stdout.write(
        `${logoIcon(f)} ${C.accent(PARTICLES.pulse[f])}${C.dim(`waiting${dots}`)}`
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
          infinity: logoIcon(af),
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
          infinity: logoIcon(af),
          // Magic wand — "the agent casts code." Disney castle-intro signature
          // emoji, semantically perfect for an AI assistant, single cell with
          // no jitter. Warm gold/brown handle + sparkle tip pops against the
          // blue model-segment background.
          agent: "🪄",
          git: "🌿",
          turn: ["✎", "✏", "✎", "✏", "✎", "✏", "✎", "✏"][af],
          context: "",
          folder: "",
          // Cut diamond — clean treasure motif. The 💰 money-bag was cluttered
          // at small size (sack texture + $ glyph fighting); 💎 reads as one
          // bright faceted shape. Cyan/blue glint contrasts beautifully with
          // the amber cost-segment bg, keeping the bar's color story coherent.
          dollar: "💎",
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
      pl.push({ text: ic(ICON.folder, monoTheme.name(trunc)), bg: seg.project });
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

    // Daemon aggregated stats — concurrent-session indicator. Kept compact.
    if (daemonResponse.connected && daemonResponse.aggregated) {
      const agg = daemonResponse.aggregated;
      if (agg.sessions > 1) {
        suffix.push(`${C.title("⊕")}${C.dim(`${agg.sessions}`)}`);
      }
    }

    // Today's totals — always shown (cached 60s). This is the cross-provider
    // roll-up across Claude Code, Codex, Qwen, etc., for the local calendar
    // day. Cache resets at midnight via the dayKey invalidation.
    const today = await getTodayTotalsCached();
    if (today && today.cost > 0) {
      suffix.push(
        `${C.accent(monoTheme.ephemeral("today"))} ${C.cost(formatCost(today.cost))} ${C.input(`${ICON.up}${formatNumber(today.in)}`)} ${C.output(`${ICON.down}${formatNumber(today.out)}`)}`
      );
      // Project roll-up — only show when it's a meaningful subset of today's
      // total (not identical to the day total, not zero). Gives you "what has
      // this repo cost me today" across every model you ran against it.
      const proj = findProjectTotal(today, projectName);
      if (proj && proj.cost > 0 && proj.cost < today.cost - 0.005) {
        suffix.push(
          `${C.accent(monoTheme.ephemeral("proj"))} ${C.cost(formatCost(proj.cost))} ${C.input(`${ICON.up}${formatNumber(proj.in)}`)} ${C.output(`${ICON.down}${formatNumber(proj.out)}`)}`
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
