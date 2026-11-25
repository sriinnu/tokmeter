/**
 * @sriinnu/tokmeter-core — Theme system.
 *
 * Defines color palettes for all tokmeter surfaces (CLI, TUI, statusline,
 * web, macOS). Themes are purely data — rendering is done by each surface
 * using its own color library (chalk, Ink, CSS, SwiftUI).
 *
 * Colors are hex strings. Surfaces convert them to their native format.
 */

import { configFilePath, loadConfig } from "./config-service.js";

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
  name: "Tokmeter",
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

const solarizedLight: Theme = {
  id: "solarized-light",
  name: "Solarized Light",
  description: "Ethan Schoonover's precision color scheme — light variant",
  variant: "light",
  colors: {
    primary: "#268bd2",
    secondary: "#2aa198",
    success: "#859900",
    warning: "#b58900",
    danger: "#dc322f",
    muted: "#93a1a1",
    text: "#657b83",
    bg: "#fdf6e3",
    cost: "#cb4b16",
    input: "#268bd2",
    output: "#d33682",
    cache: "#93a1a1",
    thinking: "#6c71c4",
    segProject: "#eee8d5",
    segModel: "#268bd2",
    segContext: "#859900",
    segGit: "#dc322f",
    segCost: "#b58900",
  },
};

const paperLight: Theme = {
  id: "light",
  name: "Light (Paper)",
  description: "Crisp daylight ink on warm paper — high readability on light terminals",
  variant: "light",
  colors: {
    primary: "#6d28d9",
    secondary: "#4c1d95",
    success: "#15803d",
    warning: "#a16207",
    danger: "#b91c1c",
    muted: "#656d76",
    text: "#1f2328",
    bg: "#f7f4ec",
    cost: "#92400e",
    input: "#1d4ed8",
    output: "#be185d",
    cache: "#656d76",
    thinking: "#6d28d9",
    segProject: "#3730a3",
    segModel: "#1d4ed8",
    segContext: "#0f766e",
    segGit: "#475569",
    segCost: "#92400e",
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
  light: paperLight,
  "solarized-light": solarizedLight,
  "high-contrast": highContrast,
};

/** Statusline semantic palette (foregrounds, chip, alerts, and pill segments). */
export interface StatuslinePalette {
  themeId: string;
  variant: "dark" | "light";
  plain: string;
  dim: string;
  ok: string;
  warn: string;
  bad: string;
  accent: string;
  cost: string;
  bold: string;
  chipFg: string;
  chipBg: string;
  alertWarnFg: string;
  alertWarnBg: string;
  alertBadFg: string;
  alertBadBg: string;
  pillSegs: readonly { fg: string; bg: string }[];
}

const DEFAULT_STATUSLINE_PALETTE: StatuslinePalette = {
  themeId: "default",
  variant: "dark",
  plain: "#e6edf3",
  dim: "#7d8590",
  ok: "#4ade80",
  warn: "#fbbf24",
  bad: "#f87171",
  accent: "#a78bfa",
  cost: "#fcd34d",
  bold: "#ffffff",
  chipFg: "#ffffff",
  chipBg: "#5b21b6",
  alertWarnFg: "#fbbf24",
  alertWarnBg: "#3b1d0a",
  alertBadFg: "#f87171",
  alertBadBg: "#3d1111",
  pillSegs: [
    { fg: "#ffffff", bg: "#4338ca" },
    { fg: "#ffffff", bg: "#2563eb" },
    { fg: "#ffffff", bg: "#0f766e" },
    { fg: "#ffffff", bg: "#b45309" },
  ],
};

const LIGHT_STATUSLINE_PALETTE: StatuslinePalette = {
  themeId: "light",
  variant: "light",
  plain: "#1f2328",
  dim: "#656d76",
  ok: "#15803d",
  warn: "#a16207",
  bad: "#b91c1c",
  accent: "#6d28d9",
  cost: "#92400e",
  bold: "#111827",
  chipFg: "#ffffff",
  chipBg: "#4c1d95",
  alertWarnFg: "#92400e",
  alertWarnBg: "#fef3c7",
  alertBadFg: "#991b1b",
  alertBadBg: "#fee2e2",
  pillSegs: [
    { fg: "#ffffff", bg: "#3730a3" },
    { fg: "#ffffff", bg: "#1d4ed8" },
    { fg: "#ffffff", bg: "#0f766e" },
    { fg: "#ffffff", bg: "#92400e" },
  ],
};

const SOLARIZED_LIGHT_STATUSLINE_PALETTE: StatuslinePalette = {
  themeId: "solarized-light",
  variant: "light",
  plain: "#586e75",
  dim: "#93a1a1",
  ok: "#6b7c00",
  warn: "#9c7000",
  bad: "#c92020",
  accent: "#268bd2",
  cost: "#b54010",
  bold: "#073642",
  chipFg: "#fdf6e3",
  chipBg: "#268bd2",
  alertWarnFg: "#8a6200",
  alertWarnBg: "#eee8d5",
  alertBadFg: "#991b1b",
  alertBadBg: "#fee2e2",
  pillSegs: [
    { fg: "#fdf6e3", bg: "#073642" },
    { fg: "#fdf6e3", bg: "#268bd2" },
    { fg: "#fdf6e3", bg: "#2aa198" },
    { fg: "#fdf6e3", bg: "#b58900" },
  ],
};

const HIGH_CONTRAST_STATUSLINE_PALETTE: StatuslinePalette = {
  themeId: "high-contrast",
  variant: "dark",
  plain: "#ffffff",
  dim: "#a3a3a3",
  ok: "#00ddff",
  warn: "#ffd000",
  bad: "#ff7b00",
  accent: "#7dd3fc",
  cost: "#ffd000",
  bold: "#ffffff",
  chipFg: "#ffffff",
  chipBg: "#004488",
  alertWarnFg: "#ffd000",
  alertWarnBg: "#423300",
  alertBadFg: "#ff8800",
  alertBadBg: "#4a2200",
  pillSegs: [
    { fg: "#ffffff", bg: "#333333" },
    { fg: "#ffffff", bg: "#004488" },
    { fg: "#ffffff", bg: "#006688" },
    { fg: "#ffffff", bg: "#886600" },
  ],
};

/** Resolve semantic statusline palette for any theme id (falls back to default). */
export function resolveStatuslinePalette(themeId?: string): StatuslinePalette {
  const theme = getTheme(themeId);
  switch (theme.id) {
    case "default":
      return DEFAULT_STATUSLINE_PALETTE;
    case "light":
      return LIGHT_STATUSLINE_PALETTE;
    case "solarized-light":
      return SOLARIZED_LIGHT_STATUSLINE_PALETTE;
    case "high-contrast":
      return HIGH_CONTRAST_STATUSLINE_PALETTE;
    default: {
      const c = theme.colors;
      return {
        themeId: theme.id,
        variant: theme.variant,
        plain: c.text,
        dim: c.muted,
        ok: c.success,
        warn: c.warning,
        bad: c.danger,
        accent: c.primary,
        cost: c.cost,
        bold: theme.variant === "light" ? "#111827" : "#ffffff",
        chipFg: theme.variant === "light" ? c.bg : "#ffffff",
        chipBg: c.segProject,
        alertWarnFg: c.warning,
        alertWarnBg: theme.variant === "light" ? "#fef3c7" : "#362b1a",
        alertBadFg: c.danger,
        alertBadBg: theme.variant === "light" ? "#fee2e2" : "#3b1b24",
        pillSegs: [
          { fg: "#ffffff", bg: c.segProject },
          { fg: "#ffffff", bg: c.segModel },
          { fg: "#ffffff", bg: c.segContext },
          { fg: "#ffffff", bg: c.segCost },
        ],
      };
    }
  }
}

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

/** Load the user's preferred theme from `~/.tokmeter/config.json` (with legacy fallback). */
export function loadUserTheme(home?: string): Theme {
  return getTheme(loadConfig(home).theme);
}

/** Check if the user opted into Nerd Font glyphs via config or env. */
export function isNerdFontEnabled(home?: string): boolean {
  if (process.env.NERD_FONT === "1" || process.env.NERD_FONTS === "1") return true;
  return loadConfig(home).nerdFont === true;
}

/** Get the canonical config file path (for display in CLI help). */
export function getConfigPath(home?: string): string {
  return configFilePath(home);
}
