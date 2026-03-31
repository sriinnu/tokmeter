import React from "react";
import { Box, Text } from "ink";
import { BarChart } from "../components/BarChart.js";
import type { ModelSummary } from "@tokmeter/core";

interface ModelsViewProps {
  models: ModelSummary[];
  totalCost: number;
}

export function ModelsView({ models, totalCost }: ModelsViewProps) {
  if (models.length === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="gray">No model data available.</Text>
      </Box>
    );
  }

  const chartData = models.slice(0, 10).map((m) => ({
    label: m.model.length > 18 ? m.model.slice(0, 15) + "..." : m.model,
    value: m.cost,
    maxValue: totalCost,
  }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ━━ Models ━━
        </Text>
      </Box>

      <BarChart data={chartData} width={40} />

      <Box marginTop={1} flexDirection="column">
        {models.map((m, i) => (
          <Box key={i} flexDirection="row">
            <Text color="gray">{m.model.padEnd(28)}</Text>
            <Text color="blue">{m.provider.padEnd(12)}</Text>
            <Text>In: {formatNum(m.inputTokens).padStart(8)}</Text>
            <Text> Out: {formatNum(m.outputTokens).padStart(8)}</Text>
            <Text color="green"> ${m.cost.toFixed(2).padStart(8)}</Text>
            <Text color="gray"> {m.percentageOfTotal.toFixed(1)}%</Text>
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
