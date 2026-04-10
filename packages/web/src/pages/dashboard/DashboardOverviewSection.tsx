import type { CSSProperties } from "react";
import { memo } from "react";
import React from "react";
import Plot from "react-plotly.js";
import { ContributionHeatmap } from "../../charts/ContributionHeatmap.js";
import { ProviderPieChart } from "../../charts/ProviderPieChart.js";
import type { LiveData } from "../../hooks/useLiveData.js";
import type { TokmeterData } from "../../hooks/useTokmeterData.js";
import { webTheme, withAlpha } from "../../theme.js";
import { DashboardPanel } from "./DashboardPanel.js";
import type { DashboardInsights } from "./buildDashboardInsights.js";
import {
  formatDashboardCostPerMillion,
  formatDashboardCurrency,
  formatDashboardNumber,
} from "./dashboardFormatters.js";

interface DashboardOverviewSectionProps {
  data: TokmeterData;
  insights: DashboardInsights;
  liveData: LiveData;
}

/**
 * Render the hero, KPI ribbon, charts, and live operations area for the richer Tokmeter dashboard.
 */
export const DashboardOverviewSection = memo(function DashboardOverviewSection({
  data,
  insights,
  liveData,
}: DashboardOverviewSectionProps) {
  return (
    <div style={sectionStackStyle}>
      <section style={heroCardStyle}>
        <div>
          <div style={heroEyebrowStyle}>{insights.spotlight.eyebrow}</div>
          <h2 style={heroTitleStyle}>{insights.spotlight.title}</h2>
          <p style={heroBodyStyle}>{insights.spotlight.body}</p>

          <div style={chipRowStyle}>
            {insights.spotlight.chips.map((chip) => (
              <span key={chip} style={spotlightChipStyle}>
                {chip}
              </span>
            ))}
          </div>
        </div>

        <div style={heroMetricsStyle}>
          {insights.heroMetrics.map((metric) => (
            <div key={metric.label} style={heroMetricCardStyle}>
              <div style={heroMetricLabelStyle}>{metric.label}</div>
              <div style={heroMetricValueStyle}>{metric.value}</div>
              <div style={heroMetricNoteStyle}>{metric.note}</div>
            </div>
          ))}
        </div>
      </section>

      <div style={kpiGridStyle}>
        {insights.kpis.map((kpi) => (
          <div key={kpi.label} style={kpiCardStyle}>
            <div style={kpiLabelStyle}>{kpi.label}</div>
            <div style={{ ...kpiValueStyle, color: kpi.accent }}>{kpi.value}</div>
            <div style={kpiHelperStyle}>{kpi.helper}</div>
          </div>
        ))}
      </div>

      <div style={dualColumnGridStyle}>
        <DashboardPanel
          eyebrow="Activity window"
          title="Daily cost and token composition"
          description="Input, output, cache, and reasoning tokens are stacked together while cost stays visible as a line, so the dashboard reads like a live economics view instead of a flat chart."
          action={
            <MetricBadge
              label="Latest view"
              value={`${insights.trendWindow.length || data.daily.length} days`}
            />
          }
        >
          <ActivityTrendPanel data={data} insights={insights} />
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Live operations"
          title="Daemon sessions right now"
          description="Live daemon numbers stay visibly separate from persisted history so the dashboard never blurs what is saved versus what is still in flight."
          action={
            <MetricBadge
              label="Stream"
              value={
                liveData.status === "connected"
                  ? "Live"
                  : liveData.status === "connecting"
                    ? "Reconnecting"
                    : "Offline"
              }
            />
          }
        >
          <LiveOperationsPanel liveData={liveData} />
        </DashboardPanel>
      </div>

      <div style={dualColumnGridStyle}>
        <DashboardPanel
          eyebrow="Provider lanes"
          title="Who owns the spend"
          description="The donut gives a quick split, while the ranked list keeps the view precise enough for decisions."
        >
          <ProviderSnapshotPanel insights={insights} />
        </DashboardPanel>

        <DashboardPanel
          eyebrow="Model mix"
          title="Where tokens are really going"
          description="Top models are shown with input, output, cache, and reasoning stacked together so expensive models are also explainable."
        >
          <ModelMixPanel insights={insights} />
        </DashboardPanel>
      </div>

      <DashboardPanel
        eyebrow="Cadence"
        title="Contribution heatmap"
        description="A denser background view of activity makes quiet weeks and bursty days visible without leaving the dashboard."
      >
        <ContributionHeatmap daily={data.daily} />
      </DashboardPanel>
    </div>
  );
});

function ActivityTrendPanel({
  data,
  insights,
}: {
  data: TokmeterData;
  insights: DashboardInsights;
}) {
  const trendData = insights.trendWindow.length > 0 ? insights.trendWindow : data.daily;

  if (trendData.length === 0) {
    return <EmptyPanelState message="Run Tokmeter once to populate the activity trend." />;
  }

  const stableBoundary = data.meta.stableThrough;
  const hasStableBoundary =
    stableBoundary !== null && trendData.some((entry) => entry.date === stableBoundary);

  return (
    <div style={contentStackStyle}>
      <div style={statsBadgeGridStyle}>
        {insights.activityHighlights.map((metric) => (
          <div key={metric.label} style={miniStatCardStyle}>
            <div style={miniStatLabelStyle}>{metric.label}</div>
            <div style={miniStatValueStyle}>{metric.value}</div>
            <div style={miniStatHelperStyle}>{metric.helper}</div>
          </div>
        ))}
      </div>

      {React.createElement(Plot, {
        data: [
          {
            x: trendData.map((entry) => entry.date),
            y: trendData.map((entry) => entry.inputTokens),
            type: "bar",
            name: "Input",
            marker: { color: webTheme.charts.input },
          },
          {
            x: trendData.map((entry) => entry.date),
            y: trendData.map((entry) => entry.outputTokens),
            type: "bar",
            name: "Output",
            marker: { color: webTheme.charts.output },
          },
          {
            x: trendData.map((entry) => entry.date),
            y: trendData.map((entry) => entry.cacheReadTokens + entry.cacheWriteTokens),
            type: "bar",
            name: "Cache",
            marker: { color: webTheme.charts.cache },
          },
          {
            x: trendData.map((entry) => entry.date),
            y: trendData.map((entry) => entry.reasoningTokens),
            type: "bar",
            name: "Reasoning",
            marker: { color: webTheme.charts.reasoning },
          },
          {
            x: trendData.map((entry) => entry.date),
            y: trendData.map((entry) => entry.cost),
            type: "scatter",
            mode: "lines+markers",
            name: "Cost",
            line: { color: webTheme.charts.cost, width: 3 },
            marker: { color: webTheme.charts.costMarker, size: 7 },
            yaxis: "y2",
          },
        ],
        layout: {
          barmode: "stack",
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { color: webTheme.text.secondary },
          legend: { orientation: "h", y: -0.18 },
          margin: { b: 78, l: 52, r: 52, t: 12 },
          xaxis: {
            tickangle: -35,
            tickfont: { color: webTheme.charts.axis },
          },
          yaxis: {
            title: "Tokens",
            rangemode: "tozero",
            gridcolor: webTheme.charts.grid,
          },
          yaxis2: {
            title: "Cost ($)",
            overlaying: "y",
            side: "right",
            rangemode: "tozero",
            gridcolor: "rgba(0, 0, 0, 0)",
          },
          shapes: hasStableBoundary
            ? [
                {
                  type: "line",
                  x0: stableBoundary,
                  x1: stableBoundary,
                  y0: 0,
                  y1: 1,
                  xref: "x",
                  yref: "paper",
                  line: {
                    color: withAlpha(webTheme.colors.cream, 0.7),
                    dash: "dot",
                    width: 2,
                  },
                },
              ]
            : [],
          annotations: hasStableBoundary
            ? [
                {
                  x: stableBoundary,
                  y: 1,
                  xref: "x",
                  yref: "paper",
                  text: "History boundary",
                  showarrow: false,
                  xanchor: "left",
                  yanchor: "bottom",
                  font: { color: webTheme.text.primary, size: 12 },
                  bgcolor: withAlpha(webTheme.colors.pine, 0.92),
                  bordercolor: withAlpha(webTheme.colors.cream, 0.18),
                  borderpad: 6,
                },
              ]
            : [],
        },
        config: { responsive: true, displayModeBar: false },
        style: { width: "100%", height: 430 },
      })}
    </div>
  );
}

function LiveOperationsPanel({ liveData }: { liveData: LiveData }) {
  if (liveData.status !== "connected" || !liveData.aggregated) {
    return (
      <div style={contentStackStyle}>
        <div style={offlineCardStyle}>
          <div style={offlineTitleStyle}>
            {liveData.status === "connecting"
              ? "Reconnecting to Drishti"
              : "Live daemon is offline"}
          </div>
          <div style={offlineBodyStyle}>
            Historical numbers stay available from the persisted summary, and live tiles will wake
            up here as soon as the daemon reconnects.
          </div>
        </div>
      </div>
    );
  }

  const aggregated = liveData.aggregated;

  return (
    <div style={contentStackStyle}>
      <div style={statsBadgeGridStyle}>
        <MiniLiveCard label="Session cost" value={formatDashboardCurrency(aggregated.totalCost)} />
        <MiniLiveCard
          label="Input tokens"
          value={formatDashboardNumber(aggregated.totalInputTokens)}
        />
        <MiniLiveCard
          label="Output tokens"
          value={formatDashboardNumber(aggregated.totalOutputTokens)}
        />
        <MiniLiveCard label="Active sessions" value={`${aggregated.sessions}`} />
      </div>

      <div style={listSectionStyle}>
        <div style={listColumnStyle}>
          <div style={listTitleStyle}>Active providers</div>
          {aggregated.byProvider.length > 0 ? (
            aggregated.byProvider.map((provider) => (
              <div key={provider.provider} style={rankedRowStyle}>
                <div>
                  <div style={rankedPrimaryStyle}>{provider.provider}</div>
                  <div style={rankedSecondaryStyle}>
                    {provider.sessions} session{provider.sessions === 1 ? "" : "s"}
                  </div>
                </div>
                <div style={rankedValueStyle}>{formatDashboardCurrency(provider.cost)}</div>
              </div>
            ))
          ) : (
            <div style={rankedSecondaryStyle}>No active providers yet.</div>
          )}
        </div>

        <div style={listColumnStyle}>
          <div style={listTitleStyle}>Active models</div>
          {aggregated.byModel.length > 0 ? (
            aggregated.byModel.slice(0, 5).map((model) => (
              <div key={model.model} style={rankedRowStyle}>
                <div>
                  <div style={rankedPrimaryStyle}>{model.model}</div>
                  <div style={rankedSecondaryStyle}>
                    {formatDashboardNumber(model.inputTokens + model.outputTokens)} tokens
                  </div>
                </div>
                <div style={rankedValueStyle}>{formatDashboardCurrency(model.cost)}</div>
              </div>
            ))
          ) : (
            <div style={rankedSecondaryStyle}>No active models yet.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function ProviderSnapshotPanel({ insights }: { insights: DashboardInsights }) {
  if (insights.providerInsights.length === 0) {
    return (
      <EmptyPanelState message="Provider split appears here once Tokmeter has provider-level history." />
    );
  }

  return (
    <div style={contentStackStyle}>
      <ProviderPieChart providers={insights.providerInsights.slice(0, 6)} />

      <div style={listColumnStyle}>
        {insights.providerInsights.slice(0, 5).map((provider) => (
          <div key={provider.provider} style={rankedRowStyle}>
            <div>
              <div style={rankedPrimaryStyle}>{provider.provider}</div>
              <div style={rankedSecondaryStyle}>
                {provider.projectCount} project{provider.projectCount === 1 ? "" : "s"} ·{" "}
                {provider.modelCount} model{provider.modelCount === 1 ? "" : "s"}
              </div>
            </div>
            <div style={rankedValueColumnStyle}>
              <div style={rankedValueStyle}>{formatDashboardCurrency(provider.cost)}</div>
              <div style={rankedSecondaryStyle}>
                {formatDashboardCostPerMillion(provider.costPerMillion)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ModelMixPanel({ insights }: { insights: DashboardInsights }) {
  if (insights.topModels.length === 0) {
    return (
      <EmptyPanelState message="Model composition shows up here once Tokmeter sees model-level history." />
    );
  }

  return (
    <div style={contentStackStyle}>
      {React.createElement(Plot, {
        data: [
          {
            x: insights.topModels.map((model) => model.model),
            y: insights.topModels.map((model) => model.inputTokens),
            type: "bar",
            name: "Input",
            marker: { color: webTheme.charts.input },
          },
          {
            x: insights.topModels.map((model) => model.model),
            y: insights.topModels.map((model) => model.outputTokens),
            type: "bar",
            name: "Output",
            marker: { color: webTheme.charts.output },
          },
          {
            x: insights.topModels.map((model) => model.model),
            y: insights.topModels.map((model) => model.cacheTokens),
            type: "bar",
            name: "Cache",
            marker: { color: webTheme.charts.cache },
          },
          {
            x: insights.topModels.map((model) => model.model),
            y: insights.topModels.map((model) => model.reasoningTokens),
            type: "bar",
            name: "Reasoning",
            marker: { color: webTheme.charts.reasoning },
          },
        ],
        layout: {
          barmode: "stack",
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { color: webTheme.text.secondary },
          margin: { b: 105, l: 48, r: 18, t: 12 },
          xaxis: { tickangle: -35 },
          yaxis: {
            title: "Tokens",
            rangemode: "tozero",
            gridcolor: webTheme.charts.grid,
          },
          legend: { orientation: "h", y: -0.24 },
        },
        config: { responsive: true, displayModeBar: false },
        style: { width: "100%", height: 420 },
      })}

      <div style={listColumnStyle}>
        {insights.topModels.slice(0, 4).map((model) => (
          <div key={`${model.provider}-${model.model}`} style={rankedRowStyle}>
            <div>
              <div style={rankedPrimaryStyle}>{model.model}</div>
              <div style={rankedSecondaryStyle}>{model.provider}</div>
            </div>
            <div style={rankedValueColumnStyle}>
              <div style={rankedValueStyle}>{formatDashboardCurrency(model.cost)}</div>
              <div style={rankedSecondaryStyle}>
                {formatDashboardNumber(model.totalTokens)} tokens
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MetricBadge({ label, value }: { label: string; value: string }) {
  return (
    <div style={metricBadgeStyle}>
      <div style={metricBadgeLabelStyle}>{label}</div>
      <div style={metricBadgeValueStyle}>{value}</div>
    </div>
  );
}

function MiniLiveCard({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniStatCardStyle}>
      <div style={miniStatLabelStyle}>{label}</div>
      <div style={miniStatValueStyle}>{value}</div>
    </div>
  );
}

function EmptyPanelState({ message }: { message: string }) {
  return <div style={emptyStateStyle}>{message}</div>;
}

const sectionStackStyle: CSSProperties = {
  display: "grid",
  gap: 24,
};

const dualColumnGridStyle: CSSProperties = {
  display: "grid",
  gap: 24,
  gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
};

const heroCardStyle: CSSProperties = {
  background: webTheme.surfaces.panelHighlight,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 32,
  boxShadow: `0 28px 110px ${webTheme.surfaces.shadow}`,
  display: "grid",
  gap: 24,
  gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
  padding: 28,
};

const heroEyebrowStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.12em",
  marginBottom: 10,
  textTransform: "uppercase",
};

const heroTitleStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 36,
  fontWeight: 800,
  letterSpacing: "-0.03em",
  lineHeight: 1.08,
  margin: 0,
};

const heroBodyStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 15,
  lineHeight: 1.8,
  margin: "14px 0 0",
  maxWidth: 760,
};

const chipRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  marginTop: 18,
};

const spotlightChipStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 999,
  color: webTheme.text.primary,
  fontSize: 12,
  fontWeight: 600,
  padding: "9px 14px",
};

const heroMetricsStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const heroMetricCardStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 20,
  padding: 18,
};

const heroMetricLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 12,
  marginBottom: 6,
  textTransform: "uppercase",
};

const heroMetricValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 20,
  fontWeight: 700,
};

const heroMetricNoteStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 13,
  lineHeight: 1.6,
  marginTop: 6,
};

const kpiGridStyle: CSSProperties = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
};

const kpiCardStyle: CSSProperties = {
  backdropFilter: "blur(16px)",
  background: `linear-gradient(180deg, ${withAlpha(webTheme.colors.pine, 0.82)}, ${withAlpha(
    webTheme.colors.teal,
    0.52
  )})`,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 22,
  boxShadow: `0 18px 48px ${withAlpha(webTheme.colors.shadow, 0.22)}`,
  padding: 18,
};

const kpiLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 12,
  fontWeight: 600,
  marginBottom: 8,
  textTransform: "uppercase",
};

const kpiValueStyle: CSSProperties = {
  fontSize: 28,
  fontWeight: 700,
  lineHeight: 1.1,
};

const kpiHelperStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 13,
  lineHeight: 1.6,
  marginTop: 8,
};

const metricBadgeStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}`,
  borderRadius: 18,
  minWidth: 132,
  padding: "10px 14px",
};

const metricBadgeLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 11,
  marginBottom: 4,
  textTransform: "uppercase",
};

const metricBadgeValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 15,
  fontWeight: 700,
};

const contentStackStyle: CSSProperties = {
  display: "grid",
  gap: 16,
};

const statsBadgeGridStyle: CSSProperties = {
  display: "grid",
  gap: 12,
  gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))",
};

const miniStatCardStyle: CSSProperties = {
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${withAlpha(webTheme.colors.cream, 0.12)}`,
  borderRadius: 16,
  padding: 14,
};

const miniStatLabelStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 11,
  marginBottom: 6,
  textTransform: "uppercase",
};

const miniStatValueStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 18,
  fontWeight: 700,
};

const miniStatHelperStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 12,
  lineHeight: 1.5,
  marginTop: 6,
};

const offlineCardStyle: CSSProperties = {
  background: `linear-gradient(180deg, ${withAlpha(webTheme.colors.teal, 0.42)}, ${withAlpha(
    webTheme.colors.pine,
    0.58
  )})`,
  border: `1px solid ${webTheme.surfaces.cardBorder}`,
  borderRadius: 20,
  padding: 20,
};

const offlineTitleStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 18,
  fontWeight: 700,
  marginBottom: 8,
};

const offlineBodyStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 14,
  lineHeight: 1.7,
};

const listSectionStyle: CSSProperties = {
  display: "grid",
  gap: 16,
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
};

const listColumnStyle: CSSProperties = {
  display: "grid",
  gap: 12,
};

const listTitleStyle: CSSProperties = {
  color: webTheme.text.muted,
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const rankedRowStyle: CSSProperties = {
  alignItems: "center",
  background: webTheme.surfaces.cardBackground,
  border: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}`,
  borderRadius: 18,
  display: "flex",
  gap: 12,
  justifyContent: "space-between",
  padding: "12px 14px",
};

const rankedPrimaryStyle: CSSProperties = {
  color: webTheme.text.primary,
  fontSize: 14,
  fontWeight: 600,
};

const rankedSecondaryStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 12,
  lineHeight: 1.5,
};

const rankedValueColumnStyle: CSSProperties = {
  textAlign: "right",
};

const rankedValueStyle: CSSProperties = {
  color: webTheme.colors.cream,
  fontSize: 14,
  fontWeight: 700,
};

const emptyStateStyle: CSSProperties = {
  color: webTheme.text.secondary,
  fontSize: 14,
  lineHeight: 1.7,
  padding: "8px 0",
};
