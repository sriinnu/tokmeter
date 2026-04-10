import type {
  DailyEntry,
  ModelSummary,
  ProviderSummary,
  TokmeterStats,
} from "@sriinnu/tokmeter-core";
import { Box, Text } from "ink";
import { BarChart } from "../components/BarChart.js";
import { Sparkline } from "../components/Sparkline.js";
import { T } from "../theme.js";

interface OverviewViewProps {
  stats: TokmeterStats;
  models: ModelSummary[];
  daily: DailyEntry[];
  providers: ProviderSummary[];
}

export function OverviewView({ stats, models, daily, providers }: OverviewViewProps) {
  if (stats.totalRecords === 0) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color={T.accent}>
          Overview
        </Text>
        <Text color={T.muted}>No token usage data found. Run some AI coding sessions first.</Text>
      </Box>
    );
  }

  const topModels = models.slice(0, 5).map((m) => ({
    label: m.model.length > 18 ? m.model.slice(0, 18) : m.model,
    value: m.cost,
    maxValue: stats.totalCost,
  }));

  const dailyCosts = daily.map((d) => d.cost);

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color={T.accent}>
          ━━ Overview ━━
        </Text>
      </Box>

      {/* Summary cards */}
      <Box flexDirection="row" marginBottom={1}>
        <Box width={20} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color={T.muted}>Total Cost</Text>
          <Text bold color={T.success}>
            ${stats.totalCost.toFixed(2)}
          </Text>
        </Box>
        <Box width={20} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color={T.muted}>Total Tokens</Text>
          <Text bold color={T.warn}>
            {formatNum(stats.totalTokens)}
          </Text>
        </Box>
        <Box width={16} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color={T.muted}>Projects</Text>
          <Text bold>{stats.projects}</Text>
        </Box>
        <Box width={16} flexDirection="column" borderStyle="round" paddingX={1}>
          <Text color={T.muted}>Active Days</Text>
          <Text bold>{stats.activeDays}</Text>
        </Box>
      </Box>

      {/* Top models bar chart */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Top Models by Cost</Text>
        <BarChart data={topModels} />
      </Box>

      {/* Daily sparkline */}
      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Daily Cost Trend</Text>
        <Sparkline data={dailyCosts} label="Cost" />
      </Box>

      {/* Provider breakdown */}
      <Box flexDirection="column">
        <Text bold>Providers</Text>
        {providers.map((p, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static data order
          <Box key={i} flexDirection="row">
            <Text color={T.muted}>{p.provider.padEnd(12)}</Text>
            <Text>
              {formatNum(p.totalTokens)} tokens | ${p.cost.toFixed(2)} (
              {p.percentageOfTotal.toFixed(1)}%)
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
