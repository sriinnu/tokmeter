/**
 * Model cost bar chart — Plotly component.
 */

import React from "react";
import Plot from "react-plotly.js";
import type { TokmeterModelSummary } from "../hooks/useTokmeterData.js";
import { webTheme } from "../theme.js";

interface Props {
  models: TokmeterModelSummary[];
}

export function ModelCostChart({ models }: Props) {
  if (models.length === 0) {
    return <div style={{ color: webTheme.text.muted, padding: 24 }}>No model data to display.</div>;
  }

  const top = models.slice(0, 15);

  return React.createElement(Plot, {
    data: [
      {
        x: top.map((m) => m.model),
        y: top.map((m) => m.cost),
        type: "bar",
        marker: { color: webTheme.colors.olive },
        name: "Cost ($)",
      },
    ],
    layout: {
      title: "Model Cost Comparison",
      xaxis: { title: "Model", tickangle: -45 },
      yaxis: { title: "Cost ($)", rangemode: "tozero" },
      margin: { b: 120 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: webTheme.text.muted },
    },
    config: { responsive: true },
    style: { width: "100%", height: 400 },
  });
}
