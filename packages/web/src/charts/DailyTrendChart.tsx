/**
 * Daily usage trend chart — Plotly component.
 */

import React from "react";
import Plot from "react-plotly.js";
import type { TokmeterDailyEntry } from "../hooks/useTokmeterData.js";
import { webTheme } from "../theme.js";

interface Props {
  daily: TokmeterDailyEntry[];
}

/** Shared Plotly font size derived from theme body token */
const baseFontSize = Number.parseInt(webTheme.typography.body.size, 10);
const titleFontSize = Number.parseInt(webTheme.typography.h3.size, 10);

export function DailyTrendChart({ daily }: Props) {
  const dates = daily.map((d) => d.date);

  return React.createElement(Plot, {
    data: [
      {
        x: dates,
        y: daily.map((d) => d.totalTokens),
        type: "scatter",
        mode: "lines+markers",
        name: "Total Tokens",
        line: { color: webTheme.charts.output },
        yaxis: "y",
      },
      {
        x: dates,
        y: daily.map((d) => d.cost),
        type: "scatter",
        mode: "lines+markers",
        name: "Cost ($)",
        line: { color: webTheme.charts.costMarker },
        yaxis: "y2",
      },
    ],
    layout: {
      title: {
        text: "Daily Usage Trend",
        font: { color: webTheme.text.primary, size: titleFontSize },
      },
      xaxis: {
        title: { text: "Date" },
        gridcolor: webTheme.charts.grid,
        color: webTheme.charts.axis,
      },
      yaxis: {
        title: { text: "Tokens" },
        side: "left",
        rangemode: "tozero",
        gridcolor: webTheme.charts.grid,
        color: webTheme.charts.axis,
      },
      yaxis2: {
        title: { text: "Cost ($)" },
        side: "right",
        overlaying: "y",
        rangemode: "tozero",
        gridcolor: webTheme.charts.grid,
        color: webTheme.charts.axis,
      },
      legend: { orientation: "h", y: -0.15, font: { color: webTheme.text.muted } },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: webTheme.text.muted, size: baseFontSize },
    },
    config: { responsive: true },
    style: { width: "100%", height: 400 },
  });
}
