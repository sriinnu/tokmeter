/**
 * Contribution heatmap — Plotly component.
 * GitHub-style calendar heatmap of daily token usage.
 */

import React from "react";
import Plot from "react-plotly.js";
import type { TokmeterDailyEntry } from "../hooks/useTokmeterData.js";
import { webTheme } from "../theme.js";

interface Props {
  daily: TokmeterDailyEntry[];
}

export function ContributionHeatmap({ daily }: Props) {
  if (daily.length === 0) {
    return (
      <div style={{ color: webTheme.text.muted, padding: 24 }}>No activity data to display.</div>
    );
  }

  const latestDate = parseLocalDate(daily[daily.length - 1]?.date ?? "") ?? new Date();
  const weeks = Math.min(26, Math.max(8, Math.ceil(daily.length / 7)));
  const startDate = new Date(latestDate);
  startDate.setDate(latestDate.getDate() - (weeks * 7 - 1));

  const valueByDate = new Map(daily.map((entry) => [entry.date, entry]));
  const z = Array.from({ length: 7 }, () => Array.from({ length: weeks }, () => 0));
  const text = Array.from({ length: 7 }, () => Array.from({ length: weeks }, () => "No activity"));
  const weekLabels = Array.from({ length: weeks }, (_, weekIndex) => {
    const weekDate = new Date(startDate);
    weekDate.setDate(startDate.getDate() + weekIndex * 7);
    return new Intl.DateTimeFormat(undefined, {
      day: "numeric",
      month: "short",
    }).format(weekDate);
  });
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

  for (let weekIndex = 0; weekIndex < weeks; weekIndex += 1) {
    for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
      const cellDate = new Date(startDate);
      cellDate.setDate(startDate.getDate() + weekIndex * 7 + dayOffset);

      const dayIndex = (cellDate.getDay() + 6) % 7;
      const dateKey = toLocalDateKey(cellDate);
      const entry = valueByDate.get(dateKey);

      z[dayIndex][weekIndex] = entry?.totalTokens ?? 0;
      text[dayIndex][weekIndex] = entry
        ? `${dateKey}<br>${entry.totalTokens.toLocaleString()} tokens<br>$${entry.cost.toFixed(2)} · ${entry.records} records`
        : `${dateKey}<br>No activity`;
    }
  }

  return React.createElement(Plot, {
    data: [
      {
        x: weekLabels,
        y: dayLabels,
        z,
        text,
        type: "heatmap",
        colorscale: webTheme.charts.heatmapScale,
        showscale: true,
        colorbar: { title: "Tokens" },
        xgap: 4,
        ygap: 4,
        hovertemplate: "%{text}<extra></extra>",
      },
    ],
    layout: {
      title: "Contribution Heatmap",
      xaxis: {
        tickangle: 0,
        tickfont: { color: webTheme.text.muted },
      },
      yaxis: {
        tickfont: { color: webTheme.text.muted },
      },
      paper_bgcolor: "transparent",
      plot_bgcolor: "transparent",
      font: { color: webTheme.text.muted },
      margin: { b: 48, l: 48, r: 48, t: 48 },
    },
    config: { responsive: true },
    style: { width: "100%", height: 320 },
  });
}

function parseLocalDate(value: string): Date | null {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
