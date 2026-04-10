import type { CSSProperties } from "react";
import { SummaryStatusBanner } from "../components/SummaryStatusBanner.js";
import type { LiveData } from "../hooks/useLiveData.js";
import { useTokmeterData } from "../hooks/useTokmeterData.js";
import { webTheme, withAlpha } from "../theme.js";
import { DashboardOverviewSection } from "./dashboard/DashboardOverviewSection.js";
import { DashboardTablesSection } from "./dashboard/DashboardTablesSection.js";
import { buildDashboardInsights } from "./dashboard/buildDashboardInsights.js";

interface DashboardPageProps {
  liveData: LiveData;
}

/**
 * Route-level orchestration for Tokmeter's transparent, multi-panel dashboard.
 */
export function DashboardPage({ liveData }: DashboardPageProps) {
  const { data, loading, error, warning, lastLoadedAt, source } = useTokmeterData();

  if (loading) {
    return renderStateCard("Loading dashboard", "Building the latest Tokmeter summary...");
  }

  if (error) {
    return renderStateCard(
      "Dashboard unavailable",
      `Tokmeter could not load a summary yet. ${error}`,
      webTheme.text.danger
    );
  }

  if (!data) {
    return renderStateCard(
      "No usage data yet",
      "Run Tokmeter once or keep the daemon open for a moment so the first summary can be generated."
    );
  }

  const insights = buildDashboardInsights(data, liveData);

  return (
    <div style={pageStyle}>
      <SummaryStatusBanner
        meta={data.meta}
        warning={warning}
        lastLoadedAt={lastLoadedAt}
        summarySource={source}
        daemonStatus={liveData.status}
      />

      <DashboardOverviewSection data={data} insights={insights} liveData={liveData} />
      <DashboardTablesSection insights={insights} />
    </div>
  );
}

function renderStateCard(title: string, message: string, accent = webTheme.text.muted) {
  return (
    <section style={stateCardStyle}>
      <div style={stateTitleStyle}>{title}</div>
      <div style={{ ...stateMessageStyle, color: accent }}>{message}</div>
    </section>
  );
}

const pageStyle: CSSProperties = {
  display: "grid",
  gap: 24,
};

const stateCardStyle: CSSProperties = {
  background: `radial-gradient(circle at top left, ${withAlpha(
    webTheme.colors.olive,
    0.12
  )}, transparent 32%), linear-gradient(180deg, ${withAlpha(webTheme.colors.pine, 0.92)}, ${withAlpha(
    webTheme.colors.teal,
    0.72
  )})`,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 28,
  boxShadow: `0 26px 90px ${webTheme.surfaces.shadow}`,
  padding: 32,
};

const stateTitleStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 24,
  fontWeight: 700,
  marginBottom: 10,
};

const stateMessageStyle: CSSProperties = {
  fontSize: 15,
  lineHeight: 1.7,
  maxWidth: 720,
};
