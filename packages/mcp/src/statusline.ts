/**
 * @tokmeter/drishti — Claude Code statusline hook handler.
 *
 * Reads JSON from stdin, computes a compact single-line status string
 * with live cost, token flow, context usage, and burn rate, and writes
 * it to stdout. Designed to run as a Claude Code statusline hook.
 *
 * ## Display Layout (inspired by pi-mono's elegant statusline)
 *
 * 【♾️】 › myproject (main) *3 › ○ sonnet-4-6 › ⚡$5.97 › ↑42K ↓18K ⟳12K › ▮ 3%/200k › 🔥$4.55/hr › today $37.8 › opus $33 · sonnet $4.5
 *
 * ## Cost Sources
 *
 * - **Session cost** — from Claude Code's own `cost.total_cost_usd` input.
 * - **Today cost** — from scanning all provider session files on disk via
 *   TokmeterCore. Pricing enrichment is enabled so records with `cost: 0`
 *   are recalculated using kosha-discovery.
 */

import { execSync } from "node:child_process";
import { TokmeterCore } from "@tokmeter/core";
import { C, formatCost, formatNumber } from "./formatter.js";

// ─── Types ──────────────────────────────────────────────────────────

/** Shape of the JSON that Claude Code pipes to the statusline hook via stdin. */
interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  version?: string;
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: { total_input_tokens?: number; context_window_size?: number };
  token_counts?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Strip "claude-" prefix and trailing date suffix from a model ID. */
function shortModelName(id: string | undefined): string {
  if (!id) return "unknown";
  let name = id;
  if (name.startsWith("claude-")) name = name.slice(7);
  name = name.replace(/-\d{8}$/, "");
  return name;
}

/** Read all of stdin as a string. */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Get git info for a directory: branch name and dirty file count.
 * Returns { branch, dirty } or null if not a git repo.
 */
function getGitInfo(cwd: string): { branch: string; dirty: number } | null {
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", {
      cwd, timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
    }).toString().trim();
    let dirty = 0;
    try {
      const status = execSync("git status --porcelain", {
        cwd, timeout: 2000, stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
      if (status) dirty = status.split("\n").length;
    } catch { /* ignore */ }
    return { branch, dirty };
  } catch {
    return null;
  }
}

/** Format context window compactly: "▮ 11.5%/200k" */
function formatContext(used: number, max: number): string {
  if (max <= 0) return "";
  const pct = (used / max) * 100;
  const maxStr = formatNumber(max);

  // Color based on utilisation
  let barColor: (s: string) => string;
  if (pct > 80) barColor = C.danger;
  else if (pct > 50) barColor = C.warn;
  else barColor = C.accent;

  // Mini bar — 8 chars, filled portion colored
  const width = 8;
  const filled = Math.round((pct / 100) * width);
  const bar = barColor("▮".repeat(filled)) + C.muted("▯".repeat(width - filled));
  return `${bar} ${barColor(`${pct.toFixed(pct >= 10 ? 0 : 1)}%`)}${C.dim(`/${maxStr}`)}`;
}

// ─── Main ───────────────────────────────────────────────────────────

export async function runStatusline(): Promise<void> {
  let input: StatuslineInput;

  try {
    const raw = await readStdin();
    input = JSON.parse(raw) as StatuslineInput;
  } catch {
    process.stdout.write(C.dim("【♾️】 waiting..."));
    return;
  }

  const parts: string[] = [];
  let modelSegment = "";

  // ── chevron separator — bright cyan like pi-mono's electric blue ──
  const sep = " " + C.chevron("❯") + " ";

  // ── Logo + Project + Git ──
  const projectDir = input.cwd ?? input.workspace?.project_dir ?? "";
  const projectName = projectDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
  const git = projectDir ? getGitInfo(projectDir) : null;

  const header: string[] = [C.title("【♾️】")];
  if (projectName) {
    let projectStr = C.accent(projectName);
    if (git) {
      projectStr += " " + C.dim(`(${git.branch})`);
      if (git.dirty > 0) projectStr += " " + C.warn(`*${git.dirty}`);
    }
    header.push(projectStr);
  }
  parts.push(header.join(" "));

  // ── Model ──
  const modelId = input.model?.id ?? input.model?.display_name;
  parts.push(C.think(`○ ${shortModelName(modelId)}`));

  // ── Session cost ──
  const sessionCost = input.cost?.total_cost_usd ?? 0;
  parts.push(C.cost(`⚡${formatCost(sessionCost)}`));

  // ── Token flow ──
  const tc = input.token_counts;
  if (tc) {
    const tokenParts: string[] = [];
    if (tc.input_tokens) tokenParts.push(C.input(`↑${formatNumber(tc.input_tokens)}`));
    if (tc.output_tokens) tokenParts.push(C.output(`↓${formatNumber(tc.output_tokens)}`));
    const cacheTotal = (tc.cache_read_tokens ?? 0) + (tc.cache_write_tokens ?? 0);
    if (cacheTotal > 0) tokenParts.push(C.cache(`⟳${formatNumber(cacheTotal)}`));
    if (tokenParts.length > 0) parts.push(tokenParts.join(" "));
  }

  // ── Context window — compact "▮▮▮▯▯▯▯▯ 3%/200k" ──
  const ctxUsed = input.context_window?.total_input_tokens ?? 0;
  const ctxMax = input.context_window?.context_window_size ?? 0;
  const ctxStr = formatContext(ctxUsed, ctxMax);
  if (ctxStr) parts.push(ctxStr);

  // ── Burn rate (after 1+ min) ──
  const durationMs = input.cost?.total_duration_ms ?? 0;
  if (durationMs > 60_000) {
    const costPerHour = sessionCost / (durationMs / 3_600_000);
    parts.push(C.warn(`🔥${formatCost(costPerHour)}/hr`));
  }

  // ── Today's totals from all agents ──
  try {
    const core = new TokmeterCore();
    const todayRecords = await core.scan({ today: true });
    if (todayRecords.length > 0) {
      let todayCost = 0;
      let todayIn = 0;
      let todayOut = 0;
      let todayCache = 0;

      const byModel = new Map<string, { cost: number; in: number; out: number }>();
      for (const r of todayRecords) {
        todayCost += r.cost;
        todayIn += r.inputTokens;
        todayOut += r.outputTokens;
        todayCache += r.cacheReadTokens + r.cacheWriteTokens;

        const shortModel = r.model
          .replace(/^claude-/, "")
          .replace(/-\d{8}$/, "")
          .replace(/^(gpt-|gemini-)/i, "");
        const entry = byModel.get(shortModel) ?? { cost: 0, in: 0, out: 0 };
        entry.cost += r.cost;
        entry.in += r.inputTokens;
        entry.out += r.outputTokens;
        byModel.set(shortModel, entry);
      }

      // Today summary — compact
      const todayTokens: string[] = [];
      if (todayIn > 0) todayTokens.push(C.input(`↑${formatNumber(todayIn)}`));
      if (todayOut > 0) todayTokens.push(C.output(`↓${formatNumber(todayOut)}`));
      if (todayCache > 0) todayTokens.push(C.cache(`⟳${formatNumber(todayCache)}`));
      const todayStr = C.accent(`today ${formatCost(todayCost)}`) +
        (todayTokens.length > 0 ? " " + todayTokens.join(" ") : "");
      parts.push(todayStr);

      // Per-model breakdown
      const activeModels = [...byModel.entries()]
        .filter(([, m]) => m.in + m.out > 0)
        .sort((a, b) => b[1].cost - a[1].cost);

      if (activeModels.length > 1) {
        modelSegment = activeModels
          .map(([model, m]) => `${C.think(model)} ${C.cost(formatCost(m.cost))}`)
          .join(C.dim(" · "));
      }
    }
  } catch {
    // Don't break the statusline for a scan failure
  }

  // ── Output ──
  if (modelSegment) parts.push(modelSegment);
  process.stdout.write(parts.join(sep));
}
