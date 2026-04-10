import type { CSSProperties } from "react";

const PINE = "#0A3323";
const OLIVE = "#839958";
const CREAM = "#F7F4D5";
const ROSE = "#D3968C";
const TEAL = "#105666";
const SHADOW = "#03130C";

/**
 * Convert a hex color into an rgba string with the provided opacity.
 */
export function withAlpha(hex: string, opacity: number): string {
  const sanitized = hex.replace("#", "");
  const normalized =
    sanitized.length === 3
      ? sanitized
          .split("")
          .map((char) => `${char}${char}`)
          .join("")
      : sanitized;

  const red = Number.parseInt(normalized.slice(0, 2), 16);
  const green = Number.parseInt(normalized.slice(2, 4), 16);
  const blue = Number.parseInt(normalized.slice(4, 6), 16);

  return `rgba(${red}, ${green}, ${blue}, ${opacity})`;
}

export const webTheme = {
  colors: {
    pine: PINE,
    olive: OLIVE,
    cream: CREAM,
    rose: ROSE,
    teal: TEAL,
    shadow: SHADOW,
  },
  text: {
    primary: CREAM,
    secondary: withAlpha(CREAM, 0.8),
    muted: withAlpha(CREAM, 0.62),
    subtle: withAlpha(CREAM, 0.48),
    emphasis: OLIVE,
    danger: ROSE,
  },
  status: {
    live: OLIVE,
    warning: ROSE,
    info: TEAL,
    offline: withAlpha(CREAM, 0.28),
  },
  surfaces: {
    shellBackground: `radial-gradient(circle at top, ${withAlpha(OLIVE, 0.2)}, ${withAlpha(PINE, 0.98)} 58%), ${PINE}`,
    navBackground: withAlpha(PINE, 0.74),
    navBorder: withAlpha(CREAM, 0.12),
    panelBackground: `linear-gradient(160deg, ${withAlpha(PINE, 0.9)}, ${withAlpha(TEAL, 0.7)} 52%, ${withAlpha(PINE, 0.78)})`,
    panelHighlight: `radial-gradient(circle at top left, ${withAlpha(OLIVE, 0.18)}, transparent 36%), radial-gradient(circle at right, ${withAlpha(TEAL, 0.16)}, transparent 28%), linear-gradient(160deg, ${withAlpha(PINE, 0.96)}, ${withAlpha(PINE, 0.78)})`,
    cardBackground: withAlpha(PINE, 0.54),
    cardBackgroundAlt: withAlpha(TEAL, 0.28),
    cardBorder: withAlpha(CREAM, 0.14),
    shadow: withAlpha(SHADOW, 0.42),
  },
  charts: {
    input: withAlpha(TEAL, 0.92),
    output: withAlpha(OLIVE, 0.92),
    cache: withAlpha(CREAM, 0.82),
    reasoning: withAlpha(ROSE, 0.9),
    cost: CREAM,
    costMarker: ROSE,
    providerPalette: [
      TEAL,
      OLIVE,
      ROSE,
      CREAM,
      PINE,
      withAlpha(TEAL, 0.76),
      withAlpha(OLIVE, 0.76),
      withAlpha(ROSE, 0.76),
    ],
    heatmapScale: [
      [0, PINE],
      [0.3, TEAL],
      [0.58, OLIVE],
      [0.82, ROSE],
      [1, CREAM],
    ] as Array<[number, string]>,
    grid: withAlpha(CREAM, 0.12),
    axis: withAlpha(CREAM, 0.6),
  },
} as const;

export const pageCardStyle: CSSProperties = {
  background: withAlpha(PINE, 0.54),
  border: `1px solid ${withAlpha(CREAM, 0.14)}`,
  borderRadius: 16,
  boxShadow: `0 20px 60px ${withAlpha(SHADOW, 0.24)}`,
};
