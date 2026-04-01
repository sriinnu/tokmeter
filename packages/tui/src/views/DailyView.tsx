import React from "react";
import { Box, Text } from "ink";
import { Sparkline } from "../components/Sparkline.js";
import { Heatmap } from "../components/Heatmap.js";
import type { DailyEntry } from "@tokmeter/core";

interface DailyViewProps {
  daily: DailyEntry[];
}

export function DailyView({ daily }: DailyViewProps) {
  if (daily.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">No daily data available.</Text>
      </Box>
    );
  }

  const costs = daily.map((d) => d.cost);
  const tokens = daily.map((d) => d.totalTokens);
  const heatmapData = daily.map((d) => ({ date: d.date, value: d.totalTokens }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ━━ Daily Summary ━━
        </Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Daily Cost</Text>
        <Sparkline data={costs} label="Cost" width={60} />
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Daily Tokens</Text>
        <Sparkline data={tokens} label="Tokens" width={60} />
      </Box>

      <Heatmap data={heatmapData} weeks={20} />

      <Box marginTop={1} flexDirection="column">
        <Text bold>Recent Days</Text>
        {daily.slice(-14).map((d, i) => (
          <Box key={i} flexDirection="row">
            <Text color="gray">{d.date}</Text>
            <Text>
              {" "}
              {formatNum(d.totalTokens)} tokens | ${d.cost.toFixed(2)} | {d.records} records
            </Text>
          </Box>
        ))}
      </Box>
    </Box>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
