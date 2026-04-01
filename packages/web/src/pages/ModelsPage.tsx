import React from "react";
import Plot from "react-plotly.js";
import { ModelCostChart } from "../charts/ModelCostChart.js";
import { type TokmeterModelSummary, useTokmeterData } from "../hooks/useTokmeterData.js";

export function ModelsPage() {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: "#8b949e" }}>Loading...</div>;
  if (error) return <div style={{ color: "#f85149" }}>Error: {error}</div>;
  if (!data) return <div style={{ color: "#8b949e" }}>No data available.</div>;
  if (data.models.length === 0) {
    return (
      <div>
        <h2 style={{ color: "#39d353" }}>Models</h2>
        <div style={{ color: "#8b949e" }}>No model usage data found.</div>
      </div>
    );
  }

  const { models } = data;
  const top15 = models.slice(0, 15);

  return (
    <div>
      <h2 style={{ color: "#39d353" }}>Models</h2>

      {/* Stacked bar: input/output/cache per model */}
      {React.createElement(Plot, {
        data: [
          {
            x: top15.map((m: TokmeterModelSummary) => m.model),
            y: top15.map((m: TokmeterModelSummary) => m.inputTokens),
            type: "bar",
            name: "Input",
            marker: { color: "#58a6ff" },
          },
          {
            x: top15.map((m: TokmeterModelSummary) => m.model),
            y: top15.map((m: TokmeterModelSummary) => m.outputTokens),
            type: "bar",
            name: "Output",
            marker: { color: "#39d353" },
          },
          {
            x: top15.map((m: TokmeterModelSummary) => m.model),
            y: top15.map((m: TokmeterModelSummary) => m.cacheReadTokens),
            type: "bar",
            name: "Cache Read",
            marker: { color: "#f0883e" },
          },
        ],
        layout: {
          title: "Token Breakdown by Model",
          barmode: "stack",
          xaxis: { title: "Model", tickangle: -45 },
          yaxis: { title: "Tokens" },
          margin: { b: 120 },
          paper_bgcolor: "transparent",
          plot_bgcolor: "transparent",
          font: { color: "#8b949e" },
        },
        config: { responsive: true },
        style: { width: "100%", height: 500 },
      })}

      <ModelCostChart models={models} />

      {/* Model table */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 24 }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #30363d" }}>
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
              <th key={h} style={{ textAlign: "left", padding: 8, color: "#8b949e" }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {models.map((m: TokmeterModelSummary, i: number) => (
            <tr key={i} style={{ borderBottom: "1px solid #21262d" }}>
              <td style={{ padding: 8, color: "#c9d1d9" }}>{m.model}</td>
              <td style={{ padding: 8, color: "#8b949e" }}>{m.provider}</td>
              <td style={{ padding: 8 }}>{formatNum(m.inputTokens)}</td>
              <td style={{ padding: 8 }}>{formatNum(m.outputTokens)}</td>
              <td style={{ padding: 8 }}>{formatNum(m.cacheReadTokens)}</td>
              <td style={{ padding: 8 }}>{formatNum(m.cacheWriteTokens)}</td>
              <td style={{ padding: 8 }}>{formatNum(m.reasoningTokens)}</td>
              <td style={{ padding: 8, color: "#39d353" }}>${m.cost.toFixed(2)}</td>
              <td style={{ padding: 8, color: "#8b949e" }}>{m.percentageOfTotal.toFixed(1)}%</td>
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
