/**
 * Contribution heatmap — Plotly component.
 * GitHub-style calendar heatmap of daily token usage.
 */

import React from "react";
import Plot from "react-plotly.js";
import type { TokmeterDailyEntry } from "../hooks/useTokmeterData.js";

interface Props {
  daily: TokmeterDailyEntry[];
}

export function ContributionHeatmap({ daily }: Props) {
  if (daily.length === 0) {
    return <div style={{ color: "#8b949e", padding: 24 }}>No activity data to display.</div>;
  }

  // Build a grid for the heatmap (week x day-of-week)
  const dates = daily.map((d) => d.date);
  const values = daily.map((d) => d.totalTokens);

  // Simple heatmap using x=date, y=1, z=tokens
  return React.createElement(Plot, {
    data: [
      {
        x: dates,
        y: values.map(() => 1),
        z: values,
        type: "heatmap",
        colorscale: [
          [0, "#161b22"],
          [0.25, "#0e4429"],
          [0.5, "#006d32"],
          [0.75, "#26a641"],
          [1, "#39d353"],
        ],
        showscale: true,
        colorbar: { title: "Tokens" },
      },
    ],
    layout: {
      title: "Contribution Heatmap",
      xaxis: { title: "Date", tickangle: -45 },
      yaxis: { visible: false },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: "#8b949e" },
      margin: { b: 80 },
    },
    config: { responsive: true },
    style: { width: "100%", height: 250 },
  });
}
