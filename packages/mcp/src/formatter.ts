/**
 * @tokmeter/drishti — Shared formatting utilities.
 *
 * Provides number, cost, duration, and bar formatters with chalk colors.
 * Used by the MCP server, statusline, and live TUI dashboard.
 */

import chalk, { type Chalk } from "chalk";

// Force TrueColor (level 3) regardless of TTY detection.
// In subprocess contexts (Claude Code statusline hook), stdout is not a TTY
// and chalk auto-detects level 0 (no color). ESM import hoisting means
// process.env.FORCE_COLOR set in cli.ts runs AFTER chalk loads.
// Explicit level assignment fixes this.
chalk.level = 3 as typeof Chalk.prototype.level;

// ─── Number Formatting ─────────────────────────────────────────────

/** Format a number compactly: 1.2M, 45.3K, 890 */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Format a cost in USD: $0.47, $12.3, $123 */
export function formatCost(n: number): string {
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

/** Format a percentage: 75.2%, 5% */
export function formatPercent(n: number): string {
  if (n >= 10) return `${n.toFixed(1)}%`;
  if (n >= 1) return `${n.toFixed(1)}%`;
  return `${n.toFixed(2)}%`;
}

/**
 * Format a visual progress bar.
 *
 * @param value - Current value.
 * @param max   - Maximum value (100%).
 * @param width - Bar width in characters (default 10).
 * @returns A string like "████░░░░░░"
 */
export function formatBar(value: number, max: number, width = 10): string {
  if (max <= 0) return "░".repeat(width);
  const ratio = Math.min(value / max, 1);
  const filled = Math.round(ratio * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** Format burn rate: $4.82/hr */
export function formatBurnRate(costPerHour: number): string {
  return `${formatCost(costPerHour)}/hr`;
}

/**
 * Format a duration from milliseconds into a human-readable string.
 *
 * Examples: "2h 15m", "45m 12s", "45s", "0s"
 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Render a sparkline from an array of values.
 *
 * Maps each value to one of the Unicode block characters ▁▂▃▄▅▆▇█
 * based on its position within the min-max range.
 */
export function sparkline(values: number[]): string {
  const chars = "▁▂▃▄▅▆▇█";
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  return values.map((v) => chars[Math.round(((v - min) / range) * (chars.length - 1))]).join("");
}

// ─── Color Constants ────────────────────────────────────────────────

/** Chalk color palette used across all drishti output. */
export const C = {
  /** Purple — titles and headings. */
  title: chalk.bold.hex("#a78bfa"),
  /** Green — accents and highlights. */
  accent: chalk.hex("#39d353"),
  /** Gold — cost values. */
  cost: chalk.bold.hex("#f0b429"),
  /** Blue — input tokens. */
  input: chalk.hex("#58a6ff"),
  /** Pink/Red — output tokens. */
  output: chalk.hex("#f97583"),
  /** Gray — cache tokens. */
  cache: chalk.hex("#8b949e"),
  /** Light purple — thinking/reasoning tokens. */
  think: chalk.hex("#d2a8ff"),
  /** Dim text. */
  dim: chalk.dim,
  /** Bold text. */
  bold: chalk.bold,
  /** Yellow — warnings. */
  warn: chalk.hex("#e3b341"),
  /** Red — danger / errors. */
  danger: chalk.hex("#f85149"),
  /** Green — success indicators. */
  success: chalk.hex("#39d353"),
  /** Dark gray — muted/background text. */
  muted: chalk.hex("#484f58"),
  /** Light gray — column headers. */
  header: chalk.bold.hex("#c9d1d9"),
  /** Border gray — separators and rules. */
  separator: chalk.hex("#30363d"),
  /** Bright cyan — chevron separators in statusline. */
  chevron: chalk.hex("#00e5ff"),
};
