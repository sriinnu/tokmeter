import type { CSSProperties } from "react";
import { useState } from "react";
import type { DashboardTodayHour } from "../pages/dashboard/buildDashboardInsights.js";
import {
  formatDashboardCurrency,
  formatDashboardNumber,
} from "../pages/dashboard/dashboardFormatters.js";
import { webTheme, withAlpha } from "../theme.js";

interface TodayHourlyChartProps {
  hours: DashboardTodayHour[];
}

/**
 * Today's activity by local hour — 24 bars with a hand-rolled hover tooltip.
 *
 * Bars encode ONE measure. Cost is the default; when every record today is
 * unpriced (subscription/local models) the whole series switches to tokens and
 * says so, rather than silently mixing dollars and token counts in one axis.
 * Hover targets span the full column height so empty hours are inspectable too.
 */
export function TodayHourlyChart({ hours }: TodayHourlyChartProps) {
  const [hovered, setHovered] = useState<number | null>(null);

  const usesTokens = hours.every((h) => h.cost === 0) && hours.some((h) => h.totalTokens > 0);
  const values = hours.map((h) => (usesTokens ? h.totalTokens : h.cost));
  const max = Math.max(...values);
  const nowHour = new Date().getHours();
  const active = hovered !== null ? hours[hovered] : null;

  return (
    <div style={rootStyle}>
      {active !== null && hovered !== null && (
        <div
          style={{
            ...tooltipStyle,
            // Edge hours anchor to the container edge instead of translating
            // by a fraction of the tooltip's own width — a percentage
            // translate still overflows the plot on narrow panels.
            ...(hovered <= 2
              ? { left: 0 }
              : hovered >= 21
                ? { right: 0 }
                : {
                    left: `${((hovered + 0.5) / 24) * 100}%`,
                    transform: "translateX(-50%)",
                  }),
          }}
        >
          <div style={tooltipTitleStyle}>
            {formatHourLabel(active.hour)} – {formatHourLabel(active.hour + 1)}
          </div>
          {active.records > 0 ? (
            <>
              <div style={tooltipRowStyle}>
                <span style={tooltipLabelStyle}>Cost</span>
                <span style={tooltipValueStyle}>{formatDashboardCurrency(active.cost)}</span>
              </div>
              <div style={tooltipRowStyle}>
                <span style={tooltipLabelStyle}>Tokens</span>
                <span style={tooltipValueStyle}>{formatDashboardNumber(active.totalTokens)}</span>
              </div>
              <div style={tooltipRowStyle}>
                <span style={tooltipLabelStyle}>Records</span>
                <span style={tooltipValueStyle}>{active.records}</span>
              </div>
              {active.topModel && (
                <div style={tooltipRowStyle}>
                  <span style={tooltipLabelStyle}>Top model</span>
                  <span style={tooltipValueStyle}>{active.topModel}</span>
                </div>
              )}
            </>
          ) : (
            <div style={tooltipEmptyStyle}>No activity</div>
          )}
        </div>
      )}

      <div style={plotStyle} onMouseLeave={() => setHovered(null)}>
        {hours.map((bucket, index) => {
          const value = values[index];
          const heightPct = max > 0 ? (value / max) * 100 : 0;
          const isNow = bucket.hour === nowHour;
          const isHovered = hovered === index;
          return (
            <div
              key={bucket.hour}
              style={columnStyle}
              onMouseEnter={() => setHovered(index)}
              role="presentation"
            >
              <div
                style={{
                  ...barStyle,
                  height: value > 0 ? `max(${heightPct}%, 3px)` : "2px",
                  background:
                    value > 0
                      ? isHovered
                        ? webTheme.colors.cream
                        : withAlpha(webTheme.colors.olive, 0.92)
                      : withAlpha(webTheme.colors.cream, 0.14),
                  boxShadow: isNow ? `0 0 0 2px ${withAlpha(webTheme.colors.cream, 0.45)}` : "none",
                }}
              />
            </div>
          );
        })}
      </div>

      <div style={axisRowStyle}>
        {[0, 6, 12, 18].map((hour) => (
          <span key={hour} style={{ ...axisTickStyle, left: `${(hour / 24) * 100}%` }}>
            {formatHourLabel(hour)}
          </span>
        ))}
        <span style={{ ...axisTickStyle, right: 0 }}>{formatHourLabel(24)}</span>
      </div>

      <div style={footRowStyle}>
        <span>
          {usesTokens
            ? "Bars show tokens per hour (no priced usage today)"
            : "Bars show cost per hour"}
        </span>
        <span style={nowLegendStyle}>
          <span style={nowDotStyle} />
          current hour
        </span>
      </div>
    </div>
  );
}

function formatHourLabel(hour: number): string {
  const h = hour % 24;
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

const rootStyle: CSSProperties = {
  position: "relative",
  display: "grid",
  gap: webTheme.spacing.sm,
};

const plotStyle: CSSProperties = {
  alignItems: "flex-end",
  borderBottom: `1px solid ${webTheme.charts.grid}`,
  display: "flex",
  gap: 2,
  height: 180,
};

const columnStyle: CSSProperties = {
  alignItems: "flex-end",
  cursor: "default",
  display: "flex",
  flex: 1,
  height: "100%",
};

const barStyle: CSSProperties = {
  borderRadius: "3px 3px 0 0",
  transition: `height ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}, background ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
  width: "100%",
};

const axisRowStyle: CSSProperties = {
  color: webTheme.charts.axis,
  fontSize: webTheme.typography.micro.size,
  height: 14,
  position: "relative",
};

const axisTickStyle: CSSProperties = {
  position: "absolute",
  top: 0,
};

const footRowStyle: CSSProperties = {
  color: webTheme.text.muted,
  display: "flex",
  fontSize: webTheme.typography.micro.size,
  justifyContent: "space-between",
};

const nowLegendStyle: CSSProperties = {
  alignItems: "center",
  display: "inline-flex",
  gap: 6,
};

const nowDotStyle: CSSProperties = {
  background: withAlpha(webTheme.colors.olive, 0.92),
  borderRadius: 2,
  boxShadow: `0 0 0 2px ${withAlpha(webTheme.colors.cream, 0.45)}`,
  display: "inline-block",
  height: 8,
  width: 8,
};

const tooltipStyle: CSSProperties = {
  background: `linear-gradient(180deg, ${withAlpha(webTheme.colors.pine, 0.98)}, ${withAlpha(
    webTheme.colors.teal,
    0.94
  )})`,
  border: `1px solid ${withAlpha(webTheme.colors.cream, 0.24)}`,
  borderRadius: webTheme.radii.lg,
  boxShadow: webTheme.elevation.high,
  bottom: "calc(100% + 6px)",
  minWidth: 168,
  padding: webTheme.spacing.md,
  pointerEvents: "none",
  position: "absolute",
  zIndex: 4,
};

const tooltipTitleStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: webTheme.typography.micro.size,
  fontWeight: 700,
  letterSpacing: "0.08em",
  marginBottom: webTheme.spacing.xs,
  textTransform: "uppercase",
};

const tooltipRowStyle: CSSProperties = {
  display: "flex",
  fontSize: webTheme.typography.caption.size,
  gap: webTheme.spacing.md,
  justifyContent: "space-between",
  lineHeight: 1.7,
};

const tooltipLabelStyle: CSSProperties = {
  color: webTheme.text.secondary,
};

const tooltipValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontWeight: 700,
  maxWidth: 200,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const tooltipEmptyStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: webTheme.typography.caption.size,
};
