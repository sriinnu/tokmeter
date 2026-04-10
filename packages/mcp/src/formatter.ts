/**
 * @sriinnu/drishti — Shared formatting utilities.
 *
 * Provides number, cost, duration, and bar formatters with chalk colors.
 * Used by the MCP server, statusline, and live TUI dashboard.
 */

import { type ThemeColors, isNerdFontEnabled, loadUserTheme } from "@sriinnu/tokmeter-core";
import chalk, { type Chalk } from "chalk";

/** Plain-text fallback for the statusline when rendering fails. No chalk, no deps. */
export const FALLBACK_STATUSLINE = "【♾️】 drishti";

// Force color output even when stdout is not a TTY (Claude Code statusline runs
// as a subprocess hook, so chalk's auto-detection picks level 0). ESM import
// hoisting means process.env.FORCE_COLOR set in cli.ts runs AFTER chalk loads,
// so we set the level explicitly here.
//
// Default: level 3 (truecolor / 16M colors). The twilight palette is designed
// for truecolor and looks noticeably worse when downsampled to 256 colors.
// We trust the terminal to handle truecolor correctly — every modern macOS
// terminal does (Terminal.app, iTerm2, Warp, kitty, alacritty, ghostty).
//
// Opt-outs:
//   NO_COLOR=1   → no color at all (respects nocolor.org standard)
//   TERM=dumb    → no color (legacy terminal compatibility)
//   FORCE_COLOR=2/1/0 → explicit user override
function detectColorLevel(): 0 | 1 | 2 | 3 {
  if (process.env.NO_COLOR) return 0;
  if (process.env.TERM === "dumb") return 0;
  const force = process.env.FORCE_COLOR;
  if (force === "0") return 0;
  if (force === "1") return 1;
  if (force === "2") return 2;
  return 3;
}
chalk.level = detectColorLevel() as typeof Chalk.prototype.level;

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

/** Powerline arrow separator — Nerd Font  (only used in nerdFont mode). */
const PL_ARROW = "\uE0B0"; //

/** Relative luminance of a hex color (0 = black, 1 = white). */
function luminance(hex: string): number {
  const r = Number.parseInt(hex.slice(1, 3), 16) / 255;
  const g = Number.parseInt(hex.slice(3, 5), 16) / 255;
  const b = Number.parseInt(hex.slice(5, 7), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Pick a foreground that contrasts cleanly with the given background.
 * WCAG-style: pivot at luminance 0.5 (more accurate than 0.45 which never
 * fired for any twilight palette color since they're all < 0.25).
 */
function fgFor(bgHex: string): string {
  return luminance(bgHex) > 0.5 ? "#1a1a2e" : "#ffffff";
}

/** Render the body of a powerline segment (no caps, no separator). */
function segmentBody(text: string, bgHex: string): string {
  const fg = chalk.hex(fgFor(bgHex));
  const bg = chalk.bgHex(bgHex);
  // Bold ensures glyphs pop on colored backgrounds across all terminal fonts.
  return bg(chalk.bold(fg(` ${text} `)));
}

/**
 * Build a powerline bar from an array of { text, bg } segments.
 *
 * Two render modes:
 *   - Nerd Font: classic powerline arrows  between segments, half-circle
 *     caps   on the ends.
 *   - Unicode (default): rounded pill caps ◖ ◗ on the ends, NO chevron
 *     between segments. The color transition between adjacent segments
 *     is enough visual separation — adding a chevron inside a pill creates
 *     a contradiction (pill with teeth). Adjacent colored cells, no
 *     glyphs between them.
 */
export function powerline(segments: { text: string; bg: string }[]): string {
  if (segments.length === 0) return "";

  const parts: string[] = [];

  if (_nerdFont) {
    // Classic powerline mode
    parts.push(chalk.hex(segments[0].bg)("\uE0B6")); // rounded left
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const nextSeg = segments[i + 1];
      parts.push(segmentBody(seg.text, seg.bg));
      if (nextSeg) {
        parts.push(chalk.bgHex(nextSeg.bg).hex(seg.bg)(PL_ARROW));
      }
    }
    parts.push(chalk.hex(segments[segments.length - 1].bg)("\uE0B4")); // rounded right
    return parts.join("");
  }

  // Unicode pill mode — adjacent colored cells with a hairline separator
  // between them. The hairline is a single ▏ left-eighth-block character
  // colored with the *next* segment's bg, sitting on the *current* segment's
  // bg. This creates a 1-pixel-thick "pixel rule" line that respects the
  // pill metaphor (no chevron teeth) while still defining the boundary.
  parts.push(chalk.hex(segments[0].bg)("◖"));
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const nextSeg = segments[i + 1];
    parts.push(segmentBody(seg.text, seg.bg));
    if (nextSeg) {
      // Hairline rule: ▏ in next color, on current bg.
      parts.push(chalk.bgHex(seg.bg).hex(nextSeg.bg)("▏"));
    }
  }
  parts.push(chalk.hex(segments[segments.length - 1].bg)("◗"));

  return parts.join("");
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
