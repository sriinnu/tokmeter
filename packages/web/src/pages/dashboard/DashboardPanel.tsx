import type { CSSProperties, ReactNode } from "react";
import { applyTypography, webTheme } from "../../theme.js";

interface DashboardPanelProps {
  eyebrow?: string;
  title: string;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
}

/**
 * Shared glass panel wrapper used across the richer Tokmeter dashboard sections.
 */
export function DashboardPanel({
  eyebrow,
  title,
  description,
  action,
  children,
  style,
  bodyStyle,
}: DashboardPanelProps) {
  return (
    <section style={{ ...panelStyle, ...style }}>
      <div style={headerStyle}>
        <div>
          {eyebrow && <div style={eyebrowStyle}>{eyebrow}</div>}
          <h3 style={titleStyle}>{title}</h3>
          {description && <p style={descriptionStyle}>{description}</p>}
        </div>
        {action && <div>{action}</div>}
      </div>

      <div style={bodyStyle}>{children}</div>
    </section>
  );
}

/** Panel container with theme radii, elevation, spacing, and motion */
const panelStyle: CSSProperties = {
  backdropFilter: "blur(22px)",
  background: webTheme.surfaces.panelBackground,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: webTheme.radii.xl,
  boxShadow: webTheme.elevation.high,
  overflow: "hidden",
  padding: webTheme.spacing.xl,
  transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
  animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
};

const headerStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  flexWrap: "wrap",
  gap: webTheme.spacing.lg,
  justifyContent: "space-between",
  marginBottom: webTheme.spacing.lg,
};

/** Eyebrow with micro typography */
const eyebrowStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.micro),
  fontWeight: 700,
  letterSpacing: "0.1em",
  marginBottom: webTheme.spacing.sm,
  textTransform: "uppercase",
};

/** Title with h1 typography */
const titleStyle: CSSProperties = {
  color: webTheme.text.primary,
  ...applyTypography(webTheme.typography.h1),
  fontSize: webTheme.spacing.xl,
  letterSpacing: "-0.02em",
  lineHeight: 1.15,
  margin: 0,
};

/** Description with body typography */
const descriptionStyle: CSSProperties = {
  color: webTheme.text.secondary,
  ...applyTypography(webTheme.typography.body),
  lineHeight: 1.7,
  margin: `${webTheme.spacing.sm} 0 0`,
  maxWidth: 760,
};
