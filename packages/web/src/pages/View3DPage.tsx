import React from "react";
import Plot from "react-plotly.js";
import { useTokmeterData } from "../hooks/useTokmeterData.js";
import { webTheme } from "../theme.js";

/**
 * 3D contribution graph — isometric surface plot.
 */
export function View3DPage() {
  const { data, loading, error } = useTokmeterData();

  if (loading) return <div style={{ color: webTheme.text.muted }}>Loading...</div>;
  if (error) return <div style={{ color: webTheme.text.danger }}>Error: {error}</div>;
  if (!data || data.daily.length === 0) {
    return (
      <div style={{ color: webTheme.text.muted }}>No data available for 3D visualization.</div>
    );
  }

  const { daily } = data;

  // Build 3D surface: x=day-of-week (0=Mon..6=Sun), y=week-number, z=tokens
  // Create a lookup map from date string to token count
  const valueByDate = new Map(daily.map((d) => [d.date, d.totalTokens]));

  // Determine the date range to cover
  const firstDate = new Date(`${daily[0].date}T00:00:00`);
  const lastDate = new Date(`${daily[daily.length - 1].date}T00:00:00`);

  // Align to week boundaries (Monday-based)
  // getDay(): 0=Sun, 1=Mon, ..., 6=Sat => convert to Mon=0..Sun=6
  const toMondayBased = (d: Date) => (d.getDay() + 6) % 7;

  // Start from the Monday of the first date's week
  const startDate = new Date(firstDate);
  startDate.setDate(startDate.getDate() - toMondayBased(firstDate));

  // End at the Sunday of the last date's week
  const endDate = new Date(lastDate);
  endDate.setDate(endDate.getDate() + (6 - toMondayBased(lastDate)));

  // Calculate number of weeks
  const totalDays = Math.round((endDate.getTime() - startDate.getTime()) / 86400000) + 1;
  const weeksNeeded = Math.ceil(totalDays / 7);

  const xLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const yLabels: string[] = [];
  const z: number[][] = [];

  for (let w = 0; w < weeksNeeded; w++) {
    const row: number[] = [];
    yLabels.push(`Week ${w + 1}`);

    for (let d = 0; d < 7; d++) {
      const cellDate = new Date(startDate);
      cellDate.setDate(cellDate.getDate() + w * 7 + d);
      const dateStr = toLocalDateKey(cellDate);
      row.push(valueByDate.get(dateStr) ?? 0);
    }
    z.push(row);
  }

  return (
    <div>
      <h2 style={{ color: webTheme.colors.olive }}>3D Contribution Graph</h2>

      {React.createElement(Plot, {
        data: [
          {
            z,
            x: xLabels,
            y: yLabels,
            type: "surface",
            colorscale: webTheme.charts.heatmapScale,
            showscale: true,
            colorbar: { title: "Tokens" },
          },
        ],
        layout: {
          title: "3D Token Usage Surface",
          scene: {
            xaxis: { title: "Day" },
            yaxis: { title: "Week" },
            zaxis: { title: "Tokens" },
            camera: { eye: { x: 1.8, y: 1.8, z: 0.8 } },
          },
          paper_bgcolor: "transparent",
          font: { color: webTheme.text.muted },
          width: 900,
          height: 600,
        },
        config: { responsive: true },
      })}
    </div>
  );
}

function toLocalDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}
