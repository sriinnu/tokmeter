import type { CSSProperties } from "react";
import React from "react";
import Plot from "react-plotly.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";
import { type TokmeterModelSummary, useTokmeterData } from "../hooks/useTokmeterData.js";
import { applyTypography, webTheme, withAlpha } from "../theme.js";

export function ModelsPage() {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: webTheme.text.muted }}>Loading...</div>;
  if (error) return <div style={{ color: webTheme.text.danger }}>Error: {error}</div>;
  if (!data) return <div style={{ color: webTheme.text.muted }}>No data available.</div>;
  if (data.models.length === 0) {
    return (
      <div>
        <h2 style={pageTitleStyle}>Models</h2>
        <div style={{ color: webTheme.text.muted }}>No model usage data found.</div>
      </div>
    );
  }

  const { models } = data;
  const top15 = models.slice(0, 15);

  return (
    <div style={pageContainerStyle}>
      <h2 style={pageTitleStyle}>Models</h2>

      {/* Stacked bar: input/output/cache per model */}
      {React.createElement(Plot, {
        data: [
          {
            x: top15.map((m: TokmeterModelSummary) => m.model),
            y: top15.map((m: TokmeterModelSummary) => m.inputTokens),
            type: "bar",
            name: "Input",
            marker: { color: webTheme.charts.input },
          },
          {
            x: top15.map((m: TokmeterModelSummary) => m.model),
            y: top15.map((m: TokmeterModelSummary) => m.outputTokens),
            type: "bar",
            name: "Output",
            marker: { color: webTheme.charts.output },
          },
          {
            x: top15.map((m: TokmeterModelSummary) => m.model),
            y: top15.map((m: TokmeterModelSummary) => m.cacheReadTokens),
            type: "bar",
            name: "Cache Read",
            marker: { color: webTheme.charts.reasoning },
          },
        ],
        layout: {
          title: {
            text: "Token Breakdown by Model",
            font: {
              color: webTheme.text.primary,
              size: Number.parseInt(webTheme.typography.h3.size),
            },
          },
          barmode: "stack",
          xaxis: {
            title: "Model",
            tickangle: -45,
            gridcolor: webTheme.charts.grid,
            color: webTheme.charts.axis,
          },
          yaxis: { title: "Tokens", gridcolor: webTheme.charts.grid, color: webTheme.charts.axis },
          margin: { b: 120 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: {
            color: webTheme.text.muted,
            size: Number.parseInt(webTheme.typography.body.size),
          },
        },
        config: { responsive: true },
        style: { width: "100%", height: 500 },
      })}

      <ModelCostChart models={models} />

      {/* Model table */}
      <table style={tableStyle}>
        <thead>
          <tr style={theadRowStyle}>
            {[
              "Model",
              "Provider",
              "Input",
              "Output",
              "Cache R",
              "Cache W",
              "Reasoning",
              "Cost",
              "%",
            ].map((h) => (
              <th key={h} style={thStyle}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((m: TokmeterModelSummary) => (
            <tr key={`${m.provider}-${m.model}`} style={tbodyRowStyle}>
              <td style={tdPrimaryStyle}>{m.model}</td>
              <td style={tdMutedStyle}>{m.provider}</td>
              <td style={tdStyle}>{formatNum(m.inputTokens)}</td>
              <td style={tdStyle}>{formatNum(m.outputTokens)}</td>
              <td style={tdStyle}>{formatNum(m.cacheReadTokens)}</td>
              <td style={tdStyle}>{formatNum(m.cacheWriteTokens)}</td>
              <td style={tdStyle}>{formatNum(m.reasoningTokens)}</td>
              <td style={tdAccentStyle}>${m.cost.toFixed(2)}</td>
              <td style={tdMutedStyle}>{m.percentageOfTotal.toFixed(1)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

/* ── Style tokens ─────────────────────────────────────────────── */

const pageContainerStyle: CSSProperties = {
  animation: `fadeUp ${webTheme.motion.duration.slow} ${webTheme.motion.easing.decelerate} both`,
};

const pageTitleStyle: CSSProperties = {
  color: webTheme.colors.olive,
  ...applyTypography(webTheme.typography.h1),
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  marginTop: webTheme.spacing.xl,
};

const theadRowStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.18)}`,
};

const thStyle: CSSProperties = {
  textAlign: "left",
  padding: webTheme.spacing.sm,
  color: webTheme.text.muted,
  ...applyTypography(webTheme.typography.caption),
  fontWeight: 700,
};

const tbodyRowStyle: CSSProperties = {
  borderBottom: `1px solid ${withAlpha(webTheme.colors.cream, 0.1)}`,
  transition: `background ${webTheme.motion.duration.fast} ${webTheme.motion.easing.default}`,
};

const tdStyle: CSSProperties = {
  padding: webTheme.spacing.sm,
  ...applyTypography(webTheme.typography.body),
};

const tdPrimaryStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.text.primary,
};

const tdMutedStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.text.muted,
};

const tdAccentStyle: CSSProperties = {
  ...tdStyle,
  color: webTheme.colors.olive,
};
