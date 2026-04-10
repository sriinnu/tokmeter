import type { CSSProperties } from "react";
import type { LiveConnectionStatus } from "../hooks/useLiveData.js";
import type { TokmeterScanMeta, TokmeterSummarySource } from "../hooks/useTokmeterData.js";
import { webTheme, withAlpha } from "../theme.js";

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
          <div style={eyebrowStyle}>Summary health</div>
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
        borderRadius: 999,
        color: tone.color,
        display: "inline-flex",
        fontSize: 12,
        fontWeight: 700,
        gap: 8,
        letterSpacing: "0.04em",
        padding: "8px 14px",
        textTransform: "uppercase",
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

const containerStyle: CSSProperties = {
  backdropFilter: "blur(18px)",
  background: `linear-gradient(135deg, ${withAlpha(webTheme.colors.pine, 0.94)}, ${withAlpha(
    webTheme.colors.teal,
    0.76
  )})`,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 24,
  boxShadow: `0 24px 80px ${webTheme.surfaces.shadow}`,
  marginBottom: 24,
  padding: 24,
};

const headerRowStyle: CSSProperties = {
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
  letterSpacing: "0.08em",
  marginBottom: 8,
  textTransform: "uppercase",
};

const headlineStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 22,
  fontWeight: 700,
  lineHeight: 1.2,
  marginBottom: 6,
};

const sublineStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 14,
  lineHeight: 1.6,
  maxWidth: 720,
};

const metricGridStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
};

const metricCardStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 18,
  padding: "14px 16px",
};

const metricLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 12,
  marginBottom: 6,
  textTransform: "uppercase",
};

const metricValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 15,
  fontWeight: 600,
};

const warningStyle: CSSProperties = {
  background: withAlpha(webTheme.colors.rose, 0.16),
  border: `1px solid ${withAlpha(webTheme.colors.rose, 0.28)}`,
  borderRadius: 16,
  color: webTheme.text.primary,
  fontSize: 13,
  lineHeight: 1.6,
  marginTop: 16,
  padding: "12px 14px",
};
