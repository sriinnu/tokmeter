import type { DailyEntry } from "@sriinnu/tokmeter-core";
import { Box, Text } from "ink";
import { Heatmap } from "../components/Heatmap.js";

interface StatsSummary {
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalRecords: number;
  projects: number;
  models: number;
  providers: number;
  activeDays: number;
  longestStreak: number;
  firstUsed: number;
  lastUsed: number;
}

interface StatsViewProps {
  stats: StatsSummary;
  daily: DailyEntry[];
}

export function StatsView({ stats, daily }: StatsViewProps) {
  const heatmapData = daily.map((d) => ({ date: d.date, value: d.totalTokens }));

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">
          ━━ Stats ━━
        </Text>
      </Box>

      <Box flexDirection="row" marginBottom={1}>
        <Box flexDirection="column" width={30}>
          <Box borderStyle="round" paddingX={1} marginBottom={1}>
            <Box flexDirection="column">
              <Text color="gray">Total Cost</Text>
              <Text bold color="green">
                ${stats.totalCost.toFixed(2)}
              </Text>
            </Box>
          </Box>
          <Box borderStyle="round" paddingX={1} marginBottom={1}>
            <Box flexDirection="column">
              <Text color="gray">Total Tokens</Text>
              <Text bold color="yellow">
                {formatNum(stats.totalTokens)}
              </Text>
            </Box>
          </Box>
          <Box borderStyle="round" paddingX={1} marginBottom={1}>
            <Box flexDirection="column">
              <Text color="gray">Input / Output</Text>
              <Text>
                {formatNum(stats.inputTokens)} / {formatNum(stats.outputTokens)}
              </Text>
            </Box>
          </Box>
        </Box>

        <Box flexDirection="column" width={30}>
          <Box borderStyle="round" paddingX={1} marginBottom={1}>
            <Box flexDirection="column">
              <Text color="gray">Projects</Text>
              <Text bold>{stats.projects}</Text>
            </Box>
          </Box>
          <Box borderStyle="round" paddingX={1} marginBottom={1}>
            <Box flexDirection="column">
              <Text color="gray">Models Used</Text>
              <Text bold>{stats.models}</Text>
            </Box>
          </Box>
          <Box borderStyle="round" paddingX={1} marginBottom={1}>
            <Box flexDirection="column">
              <Text color="gray">Longest Streak</Text>
              <Text bold color="magenta">
                {stats.longestStreak} days
              </Text>
            </Box>
          </Box>
        </Box>
      </Box>

      <Heatmap data={heatmapData} weeks={26} />
    </Box>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
