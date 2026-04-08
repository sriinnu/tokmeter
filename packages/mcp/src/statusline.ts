/**
 * @sriinnu/drishti — Claude Code statusline hook handler.
 *
 * Innovative, animated statusline with particle effects, gradients,
 * and real-time visualizations for the "wow" factor.
 *
 * Now supports cross-provider aggregation via the Drishti Daemon!
 */

import { execSync } from "node:child_process";
import type { DaemonResponse } from "./daemon/client.js";
import type { TokenUsage } from "./daemon/protocol.js";
import { C, FALLBACK_STATUSLINE, formatCost, formatNumber, formatPercent, powerline, segmentColors } from "./formatter.js";

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

/** Particle effects using braille patterns for fine-grained animation */
const PARTICLES = {
  spark: ["✦", "✧", "✶", "✷", "✸", "✹", "✺", "✻"],
  pulse: ["○", "◐", "◑", "●", "◑", "◐", "○", "◌"],
  wave: ["░", "▒", "▓", "█", "▓", "▒", "░", " "],
  orbit: ["◌", " ○", "  ●", "   ◉", "  ●", " ○", "◌", ""],
  dots: ["⠁", "⠃", "⠇", "⡇", "⣇", "⣧", "⣷", "⣿"],
};

/** Rainbow color cycle */
function rainbow(text: string, offset = 0): string {
  const colors = [
    "\x1b[38;5;196m", // red
    "\x1b[38;5;208m", // orange
    "\x1b[38;5;226m", // yellow
    "\x1b[38;5;46m", // green
    "\x1b[38;5;51m", // cyan
    "\x1b[38;5;21m", // blue
    "\x1b[38;5;129m", // purple
    "\x1b[38;5;201m", // magenta
  ];
  const f = (frame() + offset) % colors.length;
  return `${colors[f]}${text}\x1b[0m`;
}

/** Token flow visualization with animated arrows and intensity */
function animTokenFlow(
  value: number,
  type: "in" | "out" | "cache"
): { arrow: string; intensity: string } {
  const f = frame();
  const v = Math.max(0, value || 0);

  // Animated arrows
  const arrows = {
    in: ["↗", "↑", "⬆", "↑", "↗", "↑", "⬆", "↑"],
    out: ["↘", "↓", "⬇", "↓", "↘", "↓", "⬇", "↓"],
    cache: ["↺", "⟳", "↻", "⟳", "↺", "⟳", "↻", "⟳"],
  };

  // Intensity bar (grows/shrinks based on value)
  const logScale = Math.min(4, Math.floor(Math.log10(v + 1) / 1.5));
  const intensityChars = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];
  const intensity = intensityChars[(f + logScale) % intensityChars.length].repeat(
    Math.max(1, logScale)
  );

  return { arrow: arrows[type][f], intensity };
}

/** Animated cost display with pulsing effect */
function animCost(cost: number): string {
  const f = frame();
  const icons = ["⚡", "✨", "⚡", "💫", "⚡", "✨", "⚡", "🌟"];
  const icon = icons[f];

  // Color based on cost intensity
  if (cost > 10) return `${C.danger(icon)}${C.cost(formatCost(cost))}`;
  if (cost > 5) return `${C.warn(icon)}${C.cost(formatCost(cost))}`;
  return `${C.accent(icon)}${C.cost(formatCost(cost))}`;
}

/** Context window as animated progress bar with wave effect */
function animContextBar(used: number, max: number): string {
  if (!(max > 0)) return "";
  const pct = (used / max) * 100;
  const f = frame();

  // Animated wave inside the bar
  const width = 6;
  const filled = Math.round((pct / 100) * width);

  // Color gradient based on usage
  let barColor: (s: string) => string;
  if (pct > 80) barColor = C.danger;
  else if (pct > 50) barColor = C.warn;
  else barColor = C.accent;

  // Wave animation in filled portion
  const waveChars = ["▓", "▒", "░", "▒", "▓", "█", "▓", "▒"];
  let bar = "";
  for (let i = 0; i < width; i++) {
    if (i < filled) {
      bar += barColor(waveChars[(f + i) % waveChars.length]);
    } else {
      bar += C.muted("░");
    }
  }

  return `${bar} ${barColor(`${pct.toFixed(0)}%`)}${C.dim(`/${formatNumber(max)}`)}`;
}

/** Burn rate with fire animation */
function animBurnRate(costPerHour: number): string {
  const f = frame();
  const flames = ["🔥", "🔥", "🔥", "🔥"];
  const flame = flames[f % flames.length];
  return `${C.warn(flame)}${C.cost(`${formatCost(costPerHour)}/hr`)}`;
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
  const pct = used / max;
  const w = 8;
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

function getGitInfo(cwd: string): { branch: string; dirty: number } | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    let dirty = 0;
    try {
      const status = execSync("git status --porcelain", {
        cwd,
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      })
        .toString()
        .trim();
      if (status) dirty = status.split("\n").length;
    } catch {}
    return { branch, dirty };
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
    const f = frame();
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
        { provider: "claude-code", sessionId, model: modelId ?? "unknown", project: projectName, cwd: projectDir },
        sessionCost, tokens, durationMs,
      );
    } catch {}

    // ── Build Powerline Segments ──
    // One clean bar — no duplication. Each segment = one piece of info.
    const seg = segmentColors();
    const pl: { text: string; bg: string }[] = [];

    // Nerd Font glyphs — crisp SVG-like icons in patched fonts
    const ICON = {
      infinity: "【♾️】",
      agent:    "\uDB83\uDD70",  // 󰍰 nf-md-robot (agent/AI)
      git:      "\uF113",        //  nf-fa-git
      turn:     "\uF148",        //  nf-fa-level_up (turn/cycle)
      context:  "\uDB80\uDF5B",  // 󰍛 nf-md-memory (context/memory)
      folder:   "\uDB82\uDCDE",   // 󰳞 nf-md-folder
      dollar:   "\uF155",        //  nf-fa-dollar
      flame:    "\uF490",        //  nf-oct-flame
      up:       "\uF062",        //  nf-fa-arrow_up
      down:     "\uF063",        //  nf-fa-arrow_down
      refresh:  "\uF021",        //  nf-fa-refresh (cache)
      bolt:     "\uF0E7",        //  nf-fa-bolt
      calendar: "\uF073",        //  nf-fa-calendar
    };

    // 1. Logo — 【♾️】
    pl.push({ text: ICON.infinity, bg: seg.project });

    // 2. Project
    if (projectName) {
      pl.push({ text: `${ICON.folder} ${projectName}`, bg: seg.project });
    }

    // 3. Model / Agent — 󰍰 robot icon
    if (modelId) {
      pl.push({ text: `${ICON.agent} ${shortModelName(modelId)}`, bg: seg.model });
    }

    // 4. Context — 󰍛 memory icon + bar + "% left"
    if (ctxMax > 0) {
      const pctLeft = Math.max(0, 100 - (ctxUsed / ctxMax) * 100);
      const ctxBar = formatContextMini(ctxUsed, ctxMax);
      pl.push({ text: `${ICON.context} Context ${ctxBar} ${pctLeft.toFixed(1)}% left`, bg: seg.context });
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

    // Daemon aggregated stats or today's totals
    if (daemonResponse.connected && daemonResponse.aggregated) {
      const agg = daemonResponse.aggregated;
      if (agg.sessions > 1) {
        suffix.push(
          `${C.title("⊕")}${C.cost(formatCost(agg.totalCost))} ${C.input(`${ICON.up}${formatNumber(agg.totalInputTokens)}`)} ${C.output(`${ICON.down}${formatNumber(agg.totalOutputTokens)}`)}`
        );
      }
    } else {
      try {
        const { TokmeterCore } = await import("@sriinnu/tokmeter-core");
        const core = new TokmeterCore();
        const todayRecords = await core.scan({ today: true });
        if (todayRecords.length > 0) {
          let todayCost = 0, todayIn = 0, todayOut = 0;
          for (const r of todayRecords) {
            todayCost += r.cost;
            todayIn += r.inputTokens;
            todayOut += r.outputTokens;
          }
          suffix.push(
            `${C.accent(`${ICON.calendar}today`)} ${C.cost(formatCost(todayCost))} ${C.dim("│")} ${C.input(`${ICON.up}${formatNumber(todayIn)}`)} ${C.output(`${ICON.down}${formatNumber(todayOut)}`)}`
          );
        }
      } catch {}
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
