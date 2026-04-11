/**
 * @sriinnu/tokmeter-core — Theme system.
 *
 * Defines color palettes for all tokmeter surfaces (CLI, TUI, statusline,
 * web, macOS). Themes are purely data — rendering is done by each surface
 * using its own color library (chalk, Ink, CSS, SwiftUI).
 *
 * Colors are hex strings. Surfaces convert them to their native format.
 */
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
/** All built-in themes, indexed by id. */
export declare const BUILT_IN_THEMES: Record<string, Theme>;
/** Get a theme by id. Returns default theme if not found. */
export declare function getTheme(id?: string): Theme;
/** List all available theme ids. */
export declare function listThemeIds(): string[];
/** List all themes with metadata. */
export declare function listThemes(): Pick<Theme, "id" | "name" | "description" | "variant">[];
/** Load the user's preferred theme from ~/.config/tokmeter/config.json. */
export declare function loadUserTheme(): Theme;
/** Check if the user opted into Nerd Font glyphs via config or env. */
export declare function isNerdFontEnabled(): boolean;
/** Get the config file path (for display in CLI help). */
export declare function getConfigPath(): string;
