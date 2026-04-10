import type { CSSProperties } from "react";
import type { LiveConnectionStatus } from "../hooks/useLiveData.js";
import type { TokmeterScanMeta, TokmeterSummarySource } from "../hooks/useTokmeterData.js";
import { applyTypography, webTheme, withAlpha } from "../theme.js";

interface SummaryStatusBannerProps {
  meta: TokmeterScanMeta;
  warning: string | null;
  lastLoadedAt: number | null;
  summarySource: TokmeterSummarySource | null;
  daemonStatus: LiveConnectionStatus;
}

/**
 * Presents the current summary freshness, frozen-history boundary, and any
 * degraded live-state warnings without blocking the rest of the dashboard.
 */
export function SummaryStatusBanner({
  meta,
  warning,
  lastLoadedAt,
  summarySource,
  daemonStatus,
}: SummaryStatusBannerProps) {
  const tone = getTodayStateTone(meta.todayState);
  const historyMessage = meta.stableThrough
    ? `History is frozen through ${formatDate(meta.stableThrough)}.`
    : "Historical snapshot is warming up.";
  const liveMessage = getTodayStateMessage(meta.todayState);

  return (
    <section style={containerStyle}>
      <div style={headerRowStyle}>
        <div>
          <div style={eyebrowStyle}>{" Summary health"}</div>
          <div style={headlineStyle}>{historyMessage}</div>
          <div style={sublineStyle}>{liveMessage}</div>
        </div>
        <StatusPill label={tone.label} tone={tone} />
      </div>

      <div style={metricGridStyle}>
        <Metric label="Summary source" value={getSummarySourceLabel(summarySource)} />
        <Metric label="Daemon stream" value={getDaemonStatusLabel(daemonStatus)} />
        <Metric label="History source" value={getHistorySourceLabel(meta.historySource)} />
        <Metric label="Last scan" value={formatTimestamp(meta.lastScanAt)} />
        <Metric label="Browser refresh" value={formatTimestamp(lastLoadedAt)} />
      </div>

      {warning && <div style={warningStyle}>{warning}</div>}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricCardStyle}>
      <div style={metricLabelStyle}>{label}</div>
      <div style={metricValueStyle}>{value}</div>
    </div>
  );
}

function StatusPill({
  label,
  tone,
}: {
  label: string;
  tone: { background: string; border: string; color: string };
}) {
  return (
    <div
      style={{
        alignItems: "center",
        background: tone.background,
        border: `1px solid ${tone.border}`,
        borderRadius: webTheme.radii.pill,
        color: tone.color,
        display: "inline-flex",
        ...applyTypography(webTheme.typography.caption),
        fontWeight: 700,
        gap: webTheme.spacing.sm,
        letterSpacing: "0.04em",
        padding: `${webTheme.spacing.sm} ${webTheme.spacing.md}`,
        textTransform: "uppercase",
        transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
      }}
    >
      <span
        style={{
          background: tone.color,
          borderRadius: "50%",
          boxShadow: `0 0 12px ${tone.color}`,
          display: "inline-block",
          height: 8,
          width: 8,
        }}
      />
      {label}
    </div>
  );
}

function getTodayStateTone(todayState: TokmeterScanMeta["todayState"]) {
  switch (todayState) {
    case "live":
      return {
        label: "Live today",
        background: withAlpha(webTheme.colors.olive, 0.16),
        border: withAlpha(webTheme.colors.olive, 0.34),
        color: webTheme.status.live,
      };
    case "degraded":
      return {
        label: "Partial live",
        background: withAlpha(webTheme.colors.rose, 0.18),
        border: withAlpha(webTheme.colors.rose, 0.34),
        color: webTheme.status.warning,
      };
    default:
      return {
        label: "Snapshot only",
        background: withAlpha(webTheme.colors.teal, 0.18),
        border: withAlpha(webTheme.colors.cream, 0.22),
        color: webTheme.status.info,
      };
  }
}

function getTodayStateMessage(todayState: TokmeterScanMeta["todayState"]): string {
  switch (todayState) {
    case "live":
      return "Today is updating live, while earlier days stay stable until you rescan or clean up data.";
    case "degraded":
      return "Historical data is stable, but one or more live providers are temporarily unavailable.";
    default:
      return "Showing the last known summary only. Live updates will appear again when a fresh scan succeeds.";
  }
}

function getHistorySourceLabel(historySource: TokmeterScanMeta["historySource"]): string {
  switch (historySource) {
    case "snapshot":
      return "Snapshot cache";
    case "rebuilt":
      return "Fresh rebuild";
    default:
      return "Not ready";
  }
}

function getSummarySourceLabel(summarySource: TokmeterSummarySource | null): string {
  switch (summarySource) {
    case "live-api":
      return "Live API";
    case "cached-api":
      return "Persisted cache";
    case "static-cache":
      return "Static data.json";
    case "memory-cache":
      return "Browser memory cache";
    default:
      return "Waiting for data";
  }
}

function getDaemonStatusLabel(daemonStatus: LiveConnectionStatus): string {
  switch (daemonStatus) {
    case "connected":
      return "Running";
    case "connecting":
      return "Connecting";
    default:
      return "Offline";
  }
}

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(parsed);
}

function formatTimestamp(value: number | null): string {
  if (!value) {
    return "Waiting for data";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(value);
}

/** Container with fadeUp entrance animation */
const containerStyle: CSSProperties = {
  animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
  backdropFilter: "blur(18px)",
  background: `linear-gradient(135deg, ${withAlpha(webTheme.colors.pine, 0.94)}, ${withAlpha(
    webTheme.colors.teal,
    0.76
  )})`,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: webTheme.radii.xl,
  boxShadow: webTheme.elevation.high,
  marginBottom: webTheme.spacing.xl,
  padding: webTheme.spacing.xl,
  transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const headerRowStyle: CSSProperties = {
  alignItems: "flex-start",
  display: "flex",
  flexWrap: "wrap",
  gap: webTheme.spacing.lg,
  justifyContent: "space-between",
  marginBottom: webTheme.spacing.lg,
};

/** Eyebrow label with micro typography */
const eyebrowStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.micro),
  fontWeight: 700,
  letterSpacing: "0.08em",
  marginBottom: webTheme.spacing.sm,
  textTransform: "uppercase",
};

/** Headline with h2 typography */
const headlineStyle: CSSProperties = {
  color: webTheme.text.primary,
  ...applyTypography(webTheme.typography.h2),
  marginBottom: webTheme.spacing.xs,
};

/** Subline with body typography */
const sublineStyle: CSSProperties = {
  color: webTheme.text.secondary,
  ...applyTypography(webTheme.typography.body),
  lineHeight: 1.6,
  maxWidth: 720,
};

const metricGridStyle: CSSProperties = {
  display: "grid",
  gap: webTheme.spacing.md,
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
};

/** Metric card with theme radii and spacing */
const metricCardStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: webTheme.radii.lg,
  padding: `${webTheme.spacing.md} ${webTheme.spacing.lg}`,
  transition: `box-shadow ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

/** Metric label with caption typography */
const metricLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.caption),
  marginBottom: webTheme.spacing.xs,
  textTransform: "uppercase",
};

/** Metric value with h3 typography */
const metricValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: "15px",
  fontWeight: webTheme.typography.h3.weight,
};

/** Warning banner with theme tokens */
const warningStyle: CSSProperties = {
  background: withAlpha(webTheme.colors.rose, 0.16),
  border: `1px solid ${withAlpha(webTheme.colors.rose, 0.28)}`,
  borderRadius: webTheme.radii.lg,
  color: webTheme.text.primary,
  ...applyTypography(webTheme.typography.mono),
  lineHeight: 1.6,
  marginTop: webTheme.spacing.lg,
  padding: `${webTheme.spacing.md} ${webTheme.spacing.md}`,
};
