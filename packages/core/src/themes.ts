/**
 * @sriinnu/tokmeter-core — Theme system.
 *
 * Defines color palettes for all tokmeter surfaces (CLI, TUI, statusline,
 * web, macOS). Themes are purely data — rendering is done by each surface
 * using its own color library (chalk, Ink, CSS, SwiftUI).
 *
 * Colors are hex strings. Surfaces convert them to their native format.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ─── Theme Interface ────────────────────────────────────────────────────

/** Color palette for a tokmeter theme. All values are hex strings (#RRGGBB). */
export interface ThemeColors {
  /** Primary accent (branding, active tabs, highlights). */
  primary: string;
  /** Secondary accent (subtle highlights). */
  secondary: string;
  /** Success actions (installed, completed, green). */
  success: string;
  /** Warning (partial file alerts, approaching limits). */
  warning: string;
  /** Danger (destructive actions, errors, over-budget). */
  danger: string;
  /** Muted/dim text (secondary info, separators). */
  muted: string;
  /** Text on dark backgrounds. */
  text: string;
  /** Background color (for surfaces that control background). */
  bg: string;

  // ── Semantic token colors ──
  /** Cost/money values. */
  cost: string;
  /** Input tokens. */
  input: string;
  /** Output tokens. */
  output: string;
  /** Cache tokens. */
  cache: string;
  /** Reasoning/thinking tokens. */
  thinking: string;

  // ── Statusline segments (powerline style) ──
  /** Project name segment background. */
  segProject: string;
  /** Model segment background. */
  segModel: string;
  /** Context bar segment background. */
  segContext: string;
  /** Git info segment background. */
  segGit: string;
  /** Cost segment background. */
  segCost: string;
}

/** A complete tokmeter theme. */
export interface Theme {
  /** Unique theme identifier (kebab-case). */
  id: string;
  /** Display name. */
  name: string;
  /** Short description. */
  description: string;
  /** Whether this is a dark or light theme. */
  variant: "dark" | "light";
  /** The color palette. */
  colors: ThemeColors;
}

// ─── Built-in Themes ────────────────────────────────────────────────────

const defaultTheme: Theme = {
  id: "default",
  name: "Drishti",
  description: "Default purple/green theme — the original tokmeter look",
  variant: "dark",
  colors: {
    primary: "#a78bfa",
    secondary: "#7c3aed",
    success: "#39d353",
    warning: "#e3b341",
    danger: "#f85149",
    muted: "#484f58",
    text: "#c9d1d9",
    bg: "#0d1117",
    cost: "#f0b429",
    input: "#58a6ff",
    output: "#f97583",
    cache: "#8b949e",
    thinking: "#d2a8ff",
    // Twilight flow: cool indigo → blue → teal → muted slate → warm amber
    // Reads like a gradient, not a rainbow. Cost is the warm "hero" accent.
    segProject: "#4338ca", // deep indigo — identity, grounding
    segModel: "#2563eb", // royal blue — intelligence, clarity
    segContext: "#0f766e", // deep teal — health, organic
    segGit: "#475569", // slate — quiet, supporting detail
    segCost: "#b45309", // warm amber — draws the eye to money
  },
};

const tokyoNight: Theme = {
  id: "tokyo-night",
  name: "Tokyo Night",
  description: "Cool blues and purples inspired by Tokyo city lights",
  variant: "dark",
  colors: {
    primary: "#7aa2f7",
    secondary: "#bb9af7",
    success: "#9ece6a",
    warning: "#e0af68",
    danger: "#f7768e",
    muted: "#565f89",
    text: "#a9b1d6",
    bg: "#1a1b26",
    cost: "#ff9e64",
    input: "#7dcfff",
    output: "#f7768e",
    cache: "#565f89",
    thinking: "#bb9af7",
    segProject: "#3d59a1",
    segModel: "#7aa2f7",
    segContext: "#41a6b5",
    segGit: "#f7768e",
    segCost: "#e0af68",
  },
};

const catppuccin: Theme = {
  id: "catppuccin",
  name: "Catppuccin Mocha",
  description: "Warm pastel tones — easy on the eyes",
  variant: "dark",
  colors: {
    primary: "#cba6f7",
    secondary: "#f5c2e7",
    success: "#a6e3a1",
    warning: "#f9e2af",
    danger: "#f38ba8",
    muted: "#585b70",
    text: "#cdd6f4",
    bg: "#1e1e2e",
    cost: "#fab387",
    input: "#89b4fa",
    output: "#f38ba8",
    cache: "#6c7086",
    thinking: "#cba6f7",
    segProject: "#45475a",
    segModel: "#89b4fa",
    segContext: "#a6e3a1",
    segGit: "#f38ba8",
    segCost: "#fab387",
  },
};

const dracula: Theme = {
  id: "dracula",
  name: "Dracula",
  description: "Classic dark theme with vivid accents",
  variant: "dark",
  colors: {
    primary: "#bd93f9",
    secondary: "#ff79c6",
    success: "#50fa7b",
    warning: "#f1fa8c",
    danger: "#ff5555",
    muted: "#6272a4",
    text: "#f8f8f2",
    bg: "#282a36",
    cost: "#ffb86c",
    input: "#8be9fd",
    output: "#ff79c6",
    cache: "#6272a4",
    thinking: "#bd93f9",
    segProject: "#44475a",
    segModel: "#6272a4",
    segContext: "#50fa7b",
    segGit: "#ff5555",
    segCost: "#ffb86c",
  },
};

const solarizedDark: Theme = {
  id: "solarized-dark",
  name: "Solarized Dark",
  description: "Ethan Schoonover's precision color scheme — dark variant",
  variant: "dark",
  colors: {
    primary: "#268bd2",
    secondary: "#2aa198",
    success: "#859900",
    warning: "#b58900",
    danger: "#dc322f",
    muted: "#586e75",
    text: "#839496",
    bg: "#002b36",
    cost: "#cb4b16",
    input: "#268bd2",
    output: "#d33682",
    cache: "#586e75",
    thinking: "#6c71c4",
    segProject: "#073642",
    segModel: "#268bd2",
    segContext: "#859900",
    segGit: "#dc322f",
    segCost: "#b58900",
  },
};

const highContrast: Theme = {
  id: "high-contrast",
  name: "High Contrast",
  description: "Maximum readability for accessibility (colorblind-safe)",
  variant: "dark",
  colors: {
    primary: "#ffffff",
    secondary: "#00ddff",
    success: "#00bbff", // blue — distinguishable from danger for all CVD types
    warning: "#ffcc00", // yellow
    danger: "#ff8800", // orange — not red, safe for deuteranopia
    muted: "#999999",
    text: "#ffffff",
    bg: "#000000",
    cost: "#ffcc00",
    input: "#00ddff", // cyan
    output: "#ff88cc", // pink — distinct from cyan for all CVD types
    cache: "#999999",
    thinking: "#00ddff",
    segProject: "#333333",
    segModel: "#004488",
    segContext: "#006688", // teal, not green
    segGit: "#884400", // dark orange, not red
    segCost: "#886600",
  },
};

// ─── Theme Registry ─────────────────────────────────────────────────────

/** All built-in themes, indexed by id. */
export const BUILT_IN_THEMES: Record<string, Theme> = {
  default: defaultTheme,
  "tokyo-night": tokyoNight,
  catppuccin: catppuccin,
  dracula: dracula,
  "solarized-dark": solarizedDark,
  "high-contrast": highContrast,
};

/** Get a theme by id. Returns default theme if not found. */
export function getTheme(id?: string): Theme {
  if (!id) return defaultTheme;
  return BUILT_IN_THEMES[id] ?? defaultTheme;
}

/** List all available theme ids. */
export function listThemeIds(): string[] {
  return Object.keys(BUILT_IN_THEMES);
}

/** List all themes with metadata. */
export function listThemes(): Pick<Theme, "id" | "name" | "description" | "variant">[] {
  return Object.values(BUILT_IN_THEMES).map(({ id, name, description, variant }) => ({
    id,
    name,
    description,
    variant,
  }));
}

// ─── User Config ────────────────────────────────────────────────────────

/** Tokmeter user config shape (subset — only what we need). */
interface UserConfig {
  theme?: string;
  /** Enable Nerd Font glyphs in statusline (requires a patched font). Default: false. */
  nerdFont?: boolean;
}

const CONFIG_PATH = join(homedir(), ".config", "tokmeter", "config.json");

/** Load the user's preferred theme from ~/.config/tokmeter/config.json. */
export function loadUserTheme(): Theme {
  try {
    if (!existsSync(CONFIG_PATH)) return defaultTheme;
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as UserConfig;
    return getTheme(config.theme);
  } catch {
    return defaultTheme;
  }
}

/** Check if the user opted into Nerd Font glyphs via config or env. */
export function isNerdFontEnabled(): boolean {
  if (process.env.NERD_FONT === "1" || process.env.NERD_FONTS === "1") return true;
  try {
    if (!existsSync(CONFIG_PATH)) return false;
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const config = JSON.parse(raw) as UserConfig;
    return config.nerdFont === true;
  } catch {
    return false;
  }
}

/** Get the config file path (for display in CLI help). */
export function getConfigPath(): string {
  return CONFIG_PATH;
}
