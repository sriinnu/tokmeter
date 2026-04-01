/**
 * Daily usage trend chart — Plotly component.
 */

import React from "react";
import Plot from "react-plotly.js";
import type { TokmeterDailyEntry } from "../hooks/useTokmeterData.js";

interface Props {
  daily: TokmeterDailyEntry[];
}

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
        line: { color: "#39d353" },
        yaxis: "y",
      },
      {
        x: dates,
        y: daily.map((d) => d.cost),
        type: "scatter",
        mode: "lines+markers",
        name: "Cost ($)",
        line: { color: "#f0883e" },
        yaxis: "y2",
      },
    ],
    layout: {
      title: "Daily Usage Trend",
      xaxis: { title: "Date" },
      yaxis: { title: "Tokens", side: "left", rangemode: "tozero" },
      yaxis2: { title: "Cost ($)", side: "right", overlaying: "y", rangemode: "tozero" },
      legend: { orientation: "h", y: -0.15 },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: "#8b949e" },
    },
    config: { responsive: true },
    style: { width: "100%", height: 400 },
  });
}
