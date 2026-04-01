/**
 * @sriinnu/drishti — Claude Code statusline hook handler.
 *
 * Innovative, animated statusline with particle effects, gradients,
 * and real-time visualizations for the "wow" factor.
 *
 * Now supports cross-provider aggregation via the Drishti Daemon!
 */

import { execSync } from "node:child_process";
import { TokmeterCore } from "@sriinnu/tokmeter-core";
import { C, formatCost, formatNumber } from "./formatter.js";
import { syncUpdate } from "./daemon/client.js";
import type { TokenUsage } from "./daemon/protocol.js";

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
    "\x1b[38;5;46m",  // green
    "\x1b[38;5;51m",  // cyan
    "\x1b[38;5;21m",  // blue
    "\x1b[38;5;129m", // purple
    "\x1b[38;5;201m", // magenta
  ];
  const f = (frame() + offset) % colors.length;
  return `${colors[f]}${text}\x1b[0m`;
}

/** Animated spinner with glow effect */
function animatedSpinner(): string {
  const f = frame();
  const spinners = ["◜", "◠", "◝", ";top", "◞", "◡", "◟", "⊲"];
  const glows = ["", "", "✨", "", "", "", "✨", ""];
  const s = spinners[f];
  const g = glows[f];
  return `${C.chevron(g)}${C.accent(s)}`;
}

/** Token flow visualization with animated arrows and intensity */
function animTokenFlow(value: number, type: "in" | "out" | "cache"): { arrow: string; intensity: string } {
  const f = frame();

  // Animated arrows
  const arrows = {
    in:  ["↗", "↑", "⬆", "↑", "↗", "↑", "⬆", "↑"],
    out: ["↘", "↓", "⬇", "↓", "↘", "↓", "⬇", "↓"],
    cache: ["↺", "⟳", "↻", "⟳", "↺", "⟳", "↻", "⟳"],
  };

  // Intensity bar (grows/shrinks based on value)
  const logScale = Math.min(4, Math.floor(Math.log10(value + 1) / 1.5));
  const intensityChars = ["", "▁", "▂", "▃", "▄", "▅", "▆", "▇"];
  const intensity = intensityChars[(f + logScale) % intensityChars.length].repeat(Math.max(1, logScale));

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
  if (max <= 0) return "";
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
  const flames = ["🔥", " blaze", "🔥", "infern"];
  const flame = flames[f % flames.length];
  return `${C.warn(flame)}${C.cost(`${formatCost(costPerHour)}/hr`)}`;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function shortModelName(id: string | undefined): string {
  if (!id) return "?";
  let name = id;
  if (name.startsWith("claude-")) name = name.slice(7);
  name = name.replace(/-\d{8}$/, "");
  return name;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
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
  let input: StatuslineInput;

  try {
    const raw = await readStdin();
    input = JSON.parse(raw) as StatuslineInput;
  } catch {
    // Animated waiting state
    const f = frame();
    const dots = ".".repeat((f % 4));
    process.stdout.write(`${C.title("【♾️】")} ${C.accent(PARTICLES.pulse[f])}${C.dim(`waiting${dots}`)}`);
    return;
  }

  const parts: string[] = [];
  const sep = ` ${C.chevron("❯")} `;

  // ── Animated Logo with particle effect ──
  const f = frame();
  const particle = PARTICLES.spark[f];
  const pulse = PARTICLES.pulse[f];
  const logo = `${C.title("【")}${rainbow("♾️")}${C.title("】")}${C.chevron(pulse)}`;
  parts.push(logo);

  // ── Project + Git with animated indicators ──
  const projectDir = input.cwd ?? input.workspace?.project_dir ?? "";
  const projectName = projectDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const git = projectDir ? getGitInfo(projectDir) : null;

  if (projectName) {
    parts.push(`${C.accent(`📂${projectName}`)}`);
    if (git) {
      parts.push(`${C.input(`🌿${git.branch}`)}`);
      if (git.dirty > 0) {
        const dirtyIcon = f % 2 === 0 ? "✎" : "✏";
        parts.push(`${C.warn(`${dirtyIcon}${git.dirty}`)}`);
      }
    }
  }

  // ── Model with activity indicator ──
  const modelId = input.model?.id ?? input.model?.display_name;
  const modelIcon = PARTICLES.dots[f];
  parts.push(`${C.think(`${modelIcon} ${shortModelName(modelId)}`)}`);

  // ── Animated Cost ──
  const sessionCost = input.cost?.total_cost_usd ?? 0;
  parts.push(animCost(sessionCost));

  // ── Token Flow with Animation ──
  const tc = input.token_counts;
  const tokens: TokenUsage = {
    inputTokens: tc?.input_tokens ?? 0,
    outputTokens: tc?.output_tokens ?? 0,
    cacheReadTokens: tc?.cache_read_tokens ?? 0,
    cacheWriteTokens: tc?.cache_write_tokens ?? 0,
  };

  if (tc) {
    const tokenParts: string[] = [];

    if (tc.input_tokens) {
      const { arrow, intensity } = animTokenFlow(tc.input_tokens, "in");
      tokenParts.push(`${C.input(`${arrow}${formatNumber(tc.input_tokens)}${intensity}`)}`);
    }
    if (tc.output_tokens) {
      const { arrow, intensity } = animTokenFlow(tc.output_tokens, "out");
      tokenParts.push(`${C.output(`${arrow}${formatNumber(tc.output_tokens)}${intensity}`)}`);
    }
    const cacheTotal = (tc.cache_read_tokens ?? 0) + (tc.cache_write_tokens ?? 0);
    if (cacheTotal > 0) {
      const { arrow, intensity } = animTokenFlow(cacheTotal, "cache");
      tokenParts.push(`${C.cache(`${arrow}${formatNumber(cacheTotal)}${intensity}`)}`);
    }

    if (tokenParts.length > 0) parts.push(tokenParts.join(" "));
  }

  // ── Animated Context Bar ──
  const ctxUsed = input.context_window?.total_input_tokens ?? 0;
  const ctxMax = input.context_window?.context_window_size ?? 0;
  if (ctxMax > 0) {
    parts.push(animContextBar(ctxUsed, ctxMax));
  }

  // ── Burn Rate (after 1+ min) ──
  const durationMs = input.cost?.total_duration_ms ?? 0;
  if (durationMs > 60_000) {
    const costPerHour = sessionCost / (durationMs / 3_600_000);
    parts.push(animBurnRate(costPerHour));
  }

  // ── Daemon: Cross-Provider Aggregation ──
  const sessionId = input.session_id ?? `session-${Date.now()}`;
  const daemonResponse = syncUpdate(
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

  // ── Display Aggregated Stats (if daemon connected) ──
  if (daemonResponse.connected && daemonResponse.aggregated) {
    const agg = daemonResponse.aggregated;

    // Show aggregated totals from all providers
    if (agg.sessions > 1) {
      const aggIcon = f % 2 === 0 ? "🌐" : "🔗";
      const allTokens = `${C.input(`↑${formatNumber(agg.totalInputTokens)}`)} ${C.output(`↓${formatNumber(agg.totalOutputTokens)}`)}`;
      const providers = agg.providers.length > 1 ? `${C.dim("│")}${agg.providers.length} providers` : "";
      parts.push(`${C.title(`${aggIcon} All:`)}${C.cost(formatCost(agg.totalCost))} ${allTokens} ${providers}`);
    }

    // Show per-model breakdown from all sessions
    if (agg.byModel.length > 1) {
      const modelSegment = agg.byModel
        .slice(0, 4)
        .map((m) => `${C.think(m.model)} ${C.cost(formatCost(m.cost))}`)
        .join(C.dim(" · "));
      parts.push(modelSegment);
    }
  } else {
    // ── Fallback: Today's Totals from disk scan ──
    try {
      const core = new TokmeterCore();
      const todayRecords = await core.scan({ today: true });
      if (todayRecords.length > 0) {
        let todayCost = 0;
        let todayIn = 0;
        let todayOut = 0;
        const byModel = new Map<string, { cost: number; in: number; out: number }>();

        for (const r of todayRecords) {
          todayCost += r.cost;
          todayIn += r.inputTokens;
          todayOut += r.outputTokens;

          const shortModel = r.model.replace(/^claude-/, "").replace(/-\d{8}$/, "");
          const entry = byModel.get(shortModel) ?? { cost: 0, in: 0, out: 0 };
          entry.cost += r.cost;
          entry.in += r.inputTokens;
          entry.out += r.outputTokens;
          byModel.set(shortModel, entry);
        }

        // Animated today summary
        const todayIcon = f % 2 === 0 ? "📊" : "📈";
        const todayStr = `${C.accent(`${todayIcon} today ${formatCost(todayCost)}`)} ${C.dim("│")} ${C.input(`↑${formatNumber(todayIn)}`)} ${C.output(`↓${formatNumber(todayOut)}`)}`;
        parts.push(todayStr);

        // Per-model breakdown
        const activeModels = [...byModel.entries()]
          .filter(([, m]) => m.in + m.out > 0)
          .sort((a, b) => b[1].cost - a[1].cost);

        if (activeModels.length > 1) {
          const modelSegment = activeModels
            .slice(0, 3)
            .map(([model, m]) => `${C.think(model)} ${C.cost(formatCost(m.cost))}`)
            .join(C.dim(" · "));
          parts.push(modelSegment);
        }
      }
    } catch {}
  }

  // ── Output ──
  process.stdout.write(parts.join(sep));
}
