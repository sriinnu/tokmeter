import { Box, Text } from "ink";
import type React from "react";
import { T } from "../theme.js";

interface HeatmapProps {
  data: { date: string; value: number }[];
  weeks?: number;
}

/** GitHub-style contribution heatmap for Ink TUI. */
export function Heatmap({ data, weeks = 20 }: HeatmapProps) {
  if (data.length === 0) {
    return <Text color={T.muted}>No activity data</Text>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  // Build a grid of weeks x 7 days, respecting actual day-of-week alignment.
  // Day 0 = Monday (consistent with getDay() offset: 0=Mon..6=Sun).
  const recentData = data.slice(-weeks * 7);

  // Create a map from date string to value for quick lookup
  const valueByDate = new Map(recentData.map((d) => [d.date, d.value]));

  // Determine the date range to display
  const lastDate = recentData.length > 0 ? recentData[recentData.length - 1].date : "";
  const lastDateObj = new Date(`${lastDate}T00:00:00`);
  const endDate = new Date(lastDateObj);
  // Move to end of that week (Sunday)
  endDate.setDate(endDate.getDate() + (7 - (endDate.getDay() || 7)));
  // Compute start date: go back (weeks - 1) weeks from the Sunday
  const startDate = new Date(endDate);
  startDate.setDate(startDate.getDate() - (weeks * 7 - 1));

  const colors = ["gray", "#0e4429", "#006d32", "#26a641", "#39d353"];

  // Render row by row (7 rows for days of week, 0=Mon..6=Sun)
  const dayLabels = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const rows: React.ReactNode[] = [];
  for (let dayOfWeek = 0; dayOfWeek < 7; dayOfWeek++) {
    const row: React.ReactNode[] = [];
    for (let week = 0; week < weeks; week++) {
      const cellDate = new Date(startDate);
      cellDate.setDate(cellDate.getDate() + week * 7 + dayOfWeek);
      const dateStr = cellDate.toISOString().slice(0, 10);
      const value = valueByDate.get(dateStr) ?? 0;
      const intensity = value > 0 ? Math.ceil((value / max) * 4) : 0;
      const color = colors[Math.min(intensity, 4)];
      row.push(
        <Text key={`${week}-${dayOfWeek}`} color={color}>
          ██
        </Text>
      );
    }
    rows.push(
      <Box key={dayOfWeek} flexDirection="row">
        <Box width={3}>
          <Text color={T.muted}>{dayLabels[dayOfWeek]}</Text>
        </Box>
        {row}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color={T.text} bold>
        Contribution Heatmap
      </Text>
      <Box flexDirection="column" marginTop={1}>
        {rows}
      </Box>
      <Box flexDirection="row" marginTop={1}>
        <Text color={T.muted}>Less </Text>
        <Text color={colors[0]}>██</Text>
        <Text color={colors[1]}>██</Text>
        <Text color={colors[2]}>██</Text>
        <Text color={colors[3]}>██</Text>
        <Text color={colors[4]}>██</Text>
        <Text color={T.muted}> More</Text>
      </Box>
    </Box>
  );
}
