/**
 * @tokmeter/drishti — Claude Code statusline hook handler.
 *
 * Reads JSON from stdin, computes a compact single-line status string
 * with live cost, token flow, context usage, and burn rate, and writes
 * it to stdout. Designed to run as a Claude Code statusline hook.
 *
 * Config in ~/.claude/settings.json:
 *   "hooks": {
 *     "StatusLine": [{ "command": "drishti statusline" }]
 *   }
 *
 * ## Display Layout
 *
 * दृ │ ⚡$1.23 │ opus-4-6 │ ↑12.3K ↓8.1K ◆2.4K │ ███░░░░░░░ 25% │ 🔥$36.9/hr │ today:$4.56 (↑45K ↓32K)
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
import { C, formatCost, formatNumber, formatBar } from "./formatter.js";

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
  /** Token counts for the current turn / session (if provided by Claude Code). */
  token_counts?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  };
}

// ─── Helpers ────────────────────────────────────────────────────────

/**
 * Strip "claude-" prefix and trailing date suffix (e.g. "-20250514")
 * from a model identifier to produce a shorter display name.
 *
 * @example shortModelName("claude-sonnet-4-20250514") → "sonnet-4"
 */
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

// ─── Main ───────────────────────────────────────────────────────────

/**
 * Run the statusline handler.
 *
 * Reads Claude Code session JSON from stdin, computes a detailed status
 * line, and writes it to stdout. Shows:
 *
 * 1. Session cost
 * 2. Short model name
 * 3. Token flow: ↑input ↓output ⟳cache ◆reasoning
 * 4. Context window bar (color-coded)
 * 5. Burn rate $/hr (after 1+ min)
 * 6. Today's total cost + token totals from all agents
 */
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
  /** Per-model breakdown segment — appended inline to line 1 if multiple models. */
  let modelSegment = "";

  // ── Logo + Project name + Git branch ──
  const projectDir = input.cwd ?? input.workspace?.project_dir ?? "";
  const projectName = projectDir.split(/[/\\]/).filter(Boolean).pop() ?? "";
  let gitBranch = "";
  if (projectDir) {
    try {
      gitBranch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: projectDir,
        timeout: 2000,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString().trim();
    } catch {
      // not a git repo or git not available
    }
  }
  const nameSegments: string[] = [C.title("【♾️】")];
  if (projectName) nameSegments.push(C.accent(projectName));
  if (gitBranch) nameSegments.push(C.dim(`(${gitBranch})`));
  parts.push(nameSegments.join(" "));

  // ── Session cost ──
  const sessionCost = input.cost?.total_cost_usd ?? 0;
  parts.push(C.cost(`⚡${formatCost(sessionCost)}`));

  // ── Model — accented so it pops ──
  const modelId = input.model?.id ?? input.model?.display_name;
  parts.push(C.think(shortModelName(modelId)));

  // ── Session token flow ──
  const tc = input.token_counts;
  if (tc) {
    const tokenParts: string[] = [];
    if (tc.input_tokens) tokenParts.push(C.input(`↑${formatNumber(tc.input_tokens)}`));
    if (tc.output_tokens) tokenParts.push(C.output(`↓${formatNumber(tc.output_tokens)}`));
    const cacheTotal = (tc.cache_read_tokens ?? 0) + (tc.cache_write_tokens ?? 0);
    if (cacheTotal > 0) tokenParts.push(C.cache(`⟳${formatNumber(cacheTotal)}`));
    if (tokenParts.length > 0) parts.push(tokenParts.join(" "));
  }

  // ── Context window bar — filled blocks colored, empty blocks muted ──
  // Splits the bar into filled + empty so each gets its own color.
  const ctxUsed = input.context_window?.total_input_tokens ?? 0;
  const ctxMax = input.context_window?.context_window_size ?? 0;
  if (ctxMax > 0) {
    const pct = (ctxUsed / ctxMax) * 100;
    const width = 10;
    const filled = Math.round((pct / 100) * width);
    const empty = width - filled;

    // Color the filled blocks based on utilisation
    let fillColor: (s: string) => string;
    let pctColor: (s: string) => string;
    if (pct > 80) { fillColor = C.danger; pctColor = C.danger; }
    else if (pct > 50) { fillColor = C.warn; pctColor = C.warn; }
    else { fillColor = C.accent; pctColor = C.success; }

    const bar = fillColor("█".repeat(filled)) + C.muted("░".repeat(empty));
    parts.push(`${bar} ${pctColor(`${Math.round(pct)}%`)}`);
  }

  // ── Burn rate (after 1+ min) ──
  const durationMs = input.cost?.total_duration_ms ?? 0;
  if (durationMs > 60_000) {
    const costPerHour = sessionCost / (durationMs / 3_600_000);
    parts.push(C.warn(`🔥${formatCost(costPerHour)}/hr`));
  }

  // ── Today's totals from all agents (disk scan) ──
  // Itemized per model so switching between e.g. opus and sonnet is transparent.
  // Each record is already priced at its own model's rate — the total is correct,
  // but without the breakdown you can't tell which model drove which cost.
  try {
    const core = new TokmeterCore();
    const todayRecords = await core.scan({ today: true });
    if (todayRecords.length > 0) {
      let todayCost = 0;
      let todayIn = 0;
      let todayOut = 0;
      let todayCache = 0;
      let todayReasoning = 0;

      // Accumulate per-model cost + tokens in a single pass
      const byModel = new Map<string, { cost: number; in: number; out: number }>();
      for (const r of todayRecords) {
        todayCost += r.cost;
        todayIn += r.inputTokens;
        todayOut += r.outputTokens;
        todayCache += r.cacheReadTokens + r.cacheWriteTokens;
        todayReasoning += r.reasoningTokens;

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

      // Total cost + token breakdown
      const todayParts: string[] = [C.accent(`today:${formatCost(todayCost)}`)];
      const tokenDetail: string[] = [];
      if (todayIn > 0) tokenDetail.push(C.input(`↑${formatNumber(todayIn)}`));
      if (todayOut > 0) tokenDetail.push(C.output(`↓${formatNumber(todayOut)}`));
      if (todayCache > 0) tokenDetail.push(C.cache(`⟳${formatNumber(todayCache)}`));
      if (todayReasoning > 0) tokenDetail.push(C.think(`◆${formatNumber(todayReasoning)}`));
      if (tokenDetail.length > 0) todayParts.push(`(${tokenDetail.join(" ")})`);
      parts.push(todayParts.join(" "));

      // Per-model itemization — only shown if more than one model used today,
      // and only if the model has actual tokens (filter synthetic/zero entries).
      const activeModels = [...byModel.entries()]
        .filter(([, m]) => m.in + m.out > 0)   // skip zero-token noise like <synthetic>
        .sort((a, b) => b[1].cost - a[1].cost); // highest cost first

      if (activeModels.length > 1) {
        const modelItems = activeModels.map(([model, m]) =>
          `${C.think(model)} ${C.cost(formatCost(m.cost))} ${C.input(`↑${formatNumber(m.in)}`)} ${C.output(`↓${formatNumber(m.out)}`)}`
        );
        modelSegment = modelItems.join(C.separator(" · "));
      }
    }
  } catch {
    // Don't break the statusline for a scan failure
  }

  // ── Output — single line, model breakdown appended inline after today's cost ──
  // We never force a newline — Claude Code wraps naturally based on terminal width.
  const sep = C.separator(" │ ");
  if (modelSegment) parts.push(modelSegment);
  process.stdout.write(parts.join(sep));
}
