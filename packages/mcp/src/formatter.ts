/**
 * @sriinnu/drishti — Shared formatting utilities.
 *
 * Provides number, cost, duration, and bar formatters with chalk colors.
 * Used by the MCP server, statusline, and live TUI dashboard.
 */

import chalk, { type Chalk } from "chalk";
import { loadUserTheme, isNerdFontEnabled, type ThemeColors } from "@sriinnu/tokmeter-core";

/** Plain-text fallback for the statusline when rendering fails. No chalk, no deps. */
export const FALLBACK_STATUSLINE = "【♾️】 drishti";

// Force TrueColor (level 3) regardless of TTY detection.
// In subprocess contexts (Claude Code statusline hook), stdout is not a TTY
// and chalk auto-detects level 0 (no color). ESM import hoisting means
// process.env.FORCE_COLOR set in cli.ts runs AFTER chalk loads.
// Explicit level assignment fixes this.
chalk.level = 3 as typeof Chalk.prototype.level;

// ─── Active Theme ──────────────────────────────────────────────────
// Load once at module init from ~/.config/tokmeter/config.json.
// Falls back to the default Drishti theme if no config exists.
const _theme = loadUserTheme();
const _nerdFont = isNerdFontEnabled();

/** Get the active theme's colors. */
export function themeColors(): ThemeColors {
  return _theme.colors;
}

/** Get the active theme ID. */
export function activeThemeId(): string {
  return _theme.id;
}

// ─── Number Formatting ─────────────────────────────────────────────

/** Format a number compactly: 1.2M, 45.3K, 890 */
export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

/** Format a cost in USD: $0.47, $12.3, $123 */
export function formatCost(n: number): string {
  if (!Number.isFinite(n)) return "$0.00";
  if (n >= 100) return `$${n.toFixed(0)}`;
  if (n >= 10) return `$${n.toFixed(1)}`;
  return `$${n.toFixed(2)}`;
}

/** Format a percentage: 75.2%, 5% */
export function formatPercent(n: number): string {
  if (!Number.isFinite(n)) return "0.00%";
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
  if (!(max > 0) || !Number.isFinite(value)) return "░".repeat(width);
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
  if (!Number.isFinite(ms) || ms < 0) return "0s";
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
  const finite = values.filter(Number.isFinite);
  if (finite.length === 0) return "";
  const max = Math.max(...finite);
  const min = Math.min(...finite);
  const range = max - min || 1;
  return finite.map((v) => chars[Math.round(((v - min) / range) * (chars.length - 1))]).join("");
}

// ─── Color Constants (theme-aware) ──────────────────────────────────

/** Build chalk palette from active theme. */
function buildPalette(tc: ThemeColors) {
  return {
    /** Primary — titles and headings. */
    title: chalk.bold.hex(tc.primary),
    /** Green — accents and highlights. */
    accent: chalk.hex(tc.success),
    /** Gold — cost values. */
    cost: chalk.bold.hex(tc.cost),
    /** Blue — input tokens. */
    input: chalk.hex(tc.input),
    /** Pink/Red — output tokens. */
    output: chalk.hex(tc.output),
    /** Gray — cache tokens. */
    cache: chalk.hex(tc.cache),
    /** Light purple — thinking/reasoning tokens. */
    think: chalk.hex(tc.thinking),
    /** Dim text. */
    dim: chalk.dim,
    /** Bold text. */
    bold: chalk.bold,
    /** Yellow — warnings. */
    warn: chalk.hex(tc.warning),
    /** Red — danger / errors. */
    danger: chalk.hex(tc.danger),
    /** Green — success indicators. */
    success: chalk.hex(tc.success),
    /** Dark gray — muted/background text. */
    muted: chalk.hex(tc.muted),
    /** Light gray — column headers. */
    header: chalk.bold.hex(tc.text),
    /** Border gray — separators and rules. */
    separator: chalk.hex(tc.muted),
    /** Bright cyan — chevron separators in statusline. */
    chevron: chalk.hex(tc.secondary),
  };
}

/** Chalk color palette — driven by the active theme. */
export const C = buildPalette(_theme.colors);

// ─── Powerline Segment Helpers ──────────────────────────────────────

/** Whether Nerd Font glyphs are available (config or env). */
export function useNerdFont(): boolean {
  return _nerdFont;
}

/** Powerline arrow separator — Nerd Font  or gradient fade ░▒. */
const PL_ARROW = "\uE0B0"; //  (Nerd Font only)

/** Relative luminance of a hex color (0 = black, 1 = white). */
function luminance(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Render a powerline segment with transition to next segment. */
export function plSegment(text: string, bgHex: string, nextBgHex?: string): string {
  // Adaptive text color — white on dark, black on bright
  const fgColor = luminance(bgHex) > 0.45 ? "#1a1a2e" : "#ffffff";
  const fg = chalk.hex(fgColor);
  const bg = chalk.bgHex(bgHex);
  const segment = bg(fg(` ${text} `));

  if (_nerdFont) {
    // Classic powerline: sharp arrow separator
    const arrow = nextBgHex
      ? chalk.bgHex(nextBgHex).hex(bgHex)(PL_ARROW)
      : chalk.hex(bgHex)(PL_ARROW);
    return segment + arrow;
  }

  // Unicode mode: ❯ chevron separator — current color "flows into" next
  if (nextBgHex) {
    const chevron = chalk.bgHex(nextBgHex).hex(bgHex)("❯");
    return segment + chevron;
  }
  // Last segment: chevron fades to terminal background
  return segment + chalk.hex(bgHex)("❯");
}

/** Build a powerline bar from an array of { text, bg } segments. */
export function powerline(segments: { text: string; bg: string }[]): string {
  return segments
    .map((seg, i) => {
      const nextBg = segments[i + 1]?.bg;
      return plSegment(seg.text, seg.bg, nextBg);
    })
    .join("");
}

/** Get the segment background colors from the active theme. */
export function segmentColors() {
  const tc = _theme.colors;
  return {
    project: tc.segProject,
    model: tc.segModel,
    context: tc.segContext,
    git: tc.segGit,
    cost: tc.segCost,
  };
}
