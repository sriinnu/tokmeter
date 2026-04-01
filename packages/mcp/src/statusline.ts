/**
 * @tokmeter/drishti — Claude Code statusline hook handler.
 *
 * Reads JSON from stdin, computes a compact single-line status string
 * with live cost, model, context usage, and burn rate, and writes it
 * to stdout. Designed to run as a Claude Code statusline hook.
 *
 * Config in ~/.claude/settings.json:
 *   "hooks": {
 *     "StatusLine": [{ "command": "drishti statusline" }]
 *   }
 */

import { TokmeterCore } from "@tokmeter/core";
import { C, formatCost, formatBar } from "./formatter.js";

// ─── Types ──────────────────────────────────────────────────────────

interface StatuslineInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  model?: { id?: string; display_name?: string };
  workspace?: { current_dir?: string; project_dir?: string };
  version?: string;
  cost?: { total_cost_usd?: number; total_duration_ms?: number };
  context_window?: { total_input_tokens?: number; context_window_size?: number };
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Strip "claude-" prefix and trailing date suffix (e.g. "-20250514") from a model name. */
function shortModelName(id: string | undefined): string {
  if (!id) return "unknown";
  let name = id;
  // Remove "claude-" prefix
  if (name.startsWith("claude-")) name = name.slice(7);
  // Remove trailing date suffix like -20250514 or -20260115
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
 * Reads Claude Code session JSON from stdin, computes a compact status
 * line, and writes it to stdout.
 */
export async function runStatusline(): Promise<void> {
  let input: StatuslineInput;

  try {
    const raw = await readStdin();
    input = JSON.parse(raw) as StatuslineInput;
  } catch {
    // If stdin is empty or invalid JSON, output a minimal line
    process.stdout.write(C.dim("दृ waiting..."));
    return;
  }

  const parts: string[] = [];

  // ── Logo ──
  parts.push(C.title("दृ"));

  // ── Session cost from Claude Code ──
  const sessionCost = input.cost?.total_cost_usd ?? 0;
  parts.push(C.cost(`⚡${formatCost(sessionCost)}`));

  // ── Short model name ──
  const modelId = input.model?.id ?? input.model?.display_name;
  const modelName = shortModelName(modelId);
  parts.push(C.dim(modelName));

  // ── Context window usage bar ──
  const ctxUsed = input.context_window?.total_input_tokens ?? 0;
  const ctxMax = input.context_window?.context_window_size ?? 0;
  if (ctxMax > 0) {
    const pct = (ctxUsed / ctxMax) * 100;
    const bar = formatBar(ctxUsed, ctxMax, 10);
    const pctStr = `${Math.round(pct)}%`;

    // Color the bar by utilisation threshold
    let coloredBar: string;
    if (pct > 80) {
      coloredBar = C.danger(bar);
    } else if (pct > 50) {
      coloredBar = C.warn(bar);
    } else {
      coloredBar = C.success(bar);
    }
    parts.push(`${coloredBar} ${C.dim(pctStr)}`);
  }

  // ── Burn rate (only if session has been running > 1 minute) ──
  const durationMs = input.cost?.total_duration_ms ?? 0;
  if (durationMs > 60_000) {
    const durationHours = durationMs / 3_600_000;
    const costPerHour = sessionCost / durationHours;
    parts.push(C.warn(`🔥${formatCost(costPerHour)}/hr`));
  }

  // ── Today's total cost from TokmeterCore (fast scan, no pricing enrichment) ──
  try {
    const core = new TokmeterCore({ skipPricing: true });
    const todayRecords = await core.scan({ today: true });
    const todayCost = todayRecords.reduce((sum, r) => sum + r.cost, 0);
    if (todayCost > 0) {
      parts.push(C.accent(`today:${formatCost(todayCost)}`));
    }
  } catch {
    // Silently skip — don't break the statusline for a scan failure
  }

  // ── Output ──
  const sep = C.separator(" │ ");
  process.stdout.write(parts.join(sep));
}
