import type { CSSProperties, ReactNode } from "react";
import { webTheme } from "../../theme.js";

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

const panelStyle: CSSProperties = {
  backdropFilter: "blur(22px)",
  background: webTheme.surfaces.panelBackground,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 28,
  boxShadow: `0 24px 90px ${webTheme.surfaces.shadow}`,
  overflow: "hidden",
  padding: 24,
};

const headerStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  flexWrap: "wrap",
  gap: 16,
  justifyContent: "space-between",
  marginBottom: 18,
};

const eyebrowStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.1em",
  marginBottom: 8,
  textTransform: "uppercase",
};

const titleStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 24,
  fontWeight: 700,
  letterSpacing: "-0.02em",
  lineHeight: 1.15,
  margin: 0,
};

const descriptionStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 14,
  lineHeight: 1.7,
  margin: "10px 0 0",
  maxWidth: 760,
};
