import type React from "react";
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

  /** Motion tokens — every animation in the app uses these */
  motion: {
    duration: {
      instant: "100ms",
      fast: "200ms",
      normal: "350ms",
      slow: "600ms",
      glacial: "1200ms",
    },
    easing: {
      /** Material standard */
      default: "cubic-bezier(0.4, 0, 0.2, 1)",
      /** Enter screen */
      decelerate: "cubic-bezier(0, 0, 0.2, 1)",
      /** Leave screen */
      accelerate: "cubic-bezier(0.4, 0, 1, 1)",
      /** Overshoot bounce */
      spring: "cubic-bezier(0.175, 0.885, 0.32, 1.1)",
      /** Symmetric ease */
      smooth: "cubic-bezier(0.45, 0, 0.55, 1)",
    },
    /** Delay between sibling animations */
    stagger: "60ms",
  },

  /** Typography scale — 8 stops, all relative to base 16px */
  typography: {
    hero: { size: "36px", weight: 800, lineHeight: 1.1, letterSpacing: "-0.02em" } as const,
    h1: { size: "28px", weight: 700, lineHeight: 1.2, letterSpacing: "-0.015em" } as const,
    h2: { size: "22px", weight: 700, lineHeight: 1.25, letterSpacing: "-0.01em" } as const,
    h3: { size: "18px", weight: 600, lineHeight: 1.3, letterSpacing: "-0.005em" } as const,
    body: { size: "14px", weight: 500, lineHeight: 1.5, letterSpacing: "0" } as const,
    caption: { size: "12px", weight: 500, lineHeight: 1.5, letterSpacing: "0.01em" } as const,
    micro: { size: "11px", weight: 600, lineHeight: 1.4, letterSpacing: "0.02em" } as const,
    mono: { size: "13px", weight: 500, lineHeight: 1.5, letterSpacing: "0", fontFamily: "'JetBrains Mono', 'SF Mono', monospace" } as const,
  },

  /** Spacing scale — 4px base, 8 stops */
  spacing: {
    xs: "4px",
    sm: "8px",
    md: "12px",
    lg: "16px",
    xl: "24px",
    "2xl": "32px",
    "3xl": "48px",
    "4xl": "64px",
  },

  /** Radii scale — 5 stops */
  radii: {
    sm: "8px",
    md: "12px",
    lg: "16px",
    xl: "22px",
    pill: "999px",
  },

  /** Elevation scale — 4 levels */
  elevation: {
    none: "none",
    low: `0 2px 8px ${withAlpha(SHADOW, 0.3)}`,
    mid: `0 4px 16px ${withAlpha(SHADOW, 0.4)}`,
    high: `0 8px 32px ${withAlpha(SHADOW, 0.5)}`,
  },
} as const;

/** A single typography token shape */
type TypographyToken = {
  readonly size: string;
  readonly weight: number;
  readonly lineHeight: number;
  readonly letterSpacing: string;
  readonly fontFamily?: string;
};

/** Apply a typography token to a CSSProperties object */
export function applyTypography(token: TypographyToken): React.CSSProperties {
  return {
    fontSize: token.size,
    fontWeight: token.weight,
    lineHeight: token.lineHeight,
    letterSpacing: token.letterSpacing,
    ...(token.fontFamily ? { fontFamily: token.fontFamily } : {}),
  };
}

export const pageCardStyle: CSSProperties = {
  background: withAlpha(PINE, 0.54),
  border: `1px solid ${withAlpha(CREAM, 0.14)}`,
  borderRadius: 16,
  boxShadow: `0 20px 60px ${withAlpha(SHADOW, 0.24)}`,
};
