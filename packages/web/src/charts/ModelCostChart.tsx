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

/** Shared Plotly font sizes derived from theme typography tokens */
const baseFontSize = Number.parseInt(webTheme.typography.body.size);
const titleFontSize = Number.parseInt(webTheme.typography.h3.size);

export function ModelCostChart({ models }: Props) {
  if (models.length === 0) {
    return (
      <div style={{ color: webTheme.text.muted, padding: webTheme.spacing.xl }}>
        No model data to display.
      </div>
    );
  }

  const top = models.slice(0, 15);

  return React.createElement(Plot, {
    data: [
      {
        x: top.map((m) => m.model),
        y: top.map((m) => m.cost),
        type: "bar",
        marker: { color: webTheme.charts.cost },
        name: "Cost ($)",
      },
    ],
    layout: {
      title: {
        text: "Model Cost Comparison",
        font: { color: webTheme.text.primary, size: titleFontSize },
      },
      xaxis: {
        title: "Model",
        tickangle: -45,
        gridcolor: webTheme.charts.grid,
        color: webTheme.charts.axis,
      },
      yaxis: {
        title: "Cost ($)",
        rangemode: "tozero",
        gridcolor: webTheme.charts.grid,
        color: webTheme.charts.axis,
      },
      margin: { b: 120 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: webTheme.text.muted, size: baseFontSize },
    },
    config: { responsive: true },
    style: { width: "100%", height: 400 },
  });
}
