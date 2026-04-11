/**
 * tokmeter-tui — Theme adapter.
 *
 * Loads the user's theme via @sriinnu/tokmeter and exposes a flat
 * map of role names → hex colors that can be passed directly to Ink's
 * Text `color` prop. Ink supports both color names ("cyan") and hex
 * strings ("#7c3aed"), so this adapter just substitutes one for the other.
 */

import { loadUserTheme } from "@sriinnu/tokmeter";

const _theme = loadUserTheme();
const c = _theme.colors;

/**
 * Themed color palette for the TUI. Each role maps to a hex string from
 * the active theme. Pass these directly to Ink components:
 *   <Text color={T.accent}>...</Text>
 */
export const T = {
  /** Active tab, primary action highlight */
  accent: c.primary,
  /** Secondary highlights, headers */
  secondary: c.secondary,
  /** Success state — completed cleanups, restored backups */
  success: c.success,
  /** Warning state — partial file warnings, approaching budget */
  warn: c.warning,
  /** Danger state — destructive actions, errors, over-budget */
  danger: c.danger,
  /** Muted text — labels, secondary info, separators */
  muted: c.muted,
  /** Default body text — high-contrast neutral */
  text: c.text,
  /** Default theme background — rarely needed in TUI but available */
  bg: c.bg,
  /** Cost / monetary values */
  cost: c.cost,
  /** Input tokens */
  input: c.input,
  /** Output tokens */
  output: c.output,
  /** Cache tokens */
  cache: c.cache,
  /** Thinking / reasoning tokens */
  thinking: c.thinking,
} as const;
