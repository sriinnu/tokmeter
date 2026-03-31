import React from "react";
import { Box, Text } from "ink";

interface BarChartProps {
  data: { label: string; value: number; maxValue: number }[];
  width?: number;
  barChar?: string;
}

/** Horizontal bar chart component for Ink TUI. */
export function BarChart({ data, width = 30, barChar = "█" }: BarChartProps) {
  if (data.length === 0) {
    return <Text color="gray">No data</Text>;
  }

  const max = Math.max(...data.map((d) => d.value), 1);

  return (
    <Box flexDirection="column">
      {data.map((item, i) => {
        const barWidth = Math.round((item.value / max) * width);
        const bar = barChar.repeat(barWidth);
        const percentage = item.maxValue > 0 ? ((item.value / item.maxValue) * 100).toFixed(1) : "0.0";

        return (
          <Box key={i} flexDirection="row">
            <Box width={20}>
              <Text color="gray">{item.label.slice(0, 20).padEnd(20)}</Text>
            </Box>
            <Box width={width + 2}>
              <Text color="green">{bar}</Text>
            </Box>
            <Box width={12}>
              <Text color="white">{formatNumber(item.value)}</Text>
            </Box>
            <Box>
              <Text color="gray">{percentage}%</Text>
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
