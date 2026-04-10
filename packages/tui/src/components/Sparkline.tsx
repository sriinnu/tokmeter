import { Box, Text } from "ink";
import { T } from "../theme.js";

interface SparklineProps {
  data: number[];
  width?: number;
  label?: string;
}

const SPARK_CHARS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

/** Sparkline chart component for Ink TUI. */
export function Sparkline({ data, width = 50, label }: SparklineProps) {
  if (data.length === 0) {
    return <Text color={T.muted}>No data</Text>;
  }

  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;

  // Downsample or pad to fit width
  let samples = data;
  if (data.length > width) {
    const step = data.length / width;
    samples = Array.from({ length: width }, (_, i) => data[Math.floor(i * step)]);
  }

  const spark = samples
    .map((v) => {
      const idx = Math.round(((v - min) / range) * (SPARK_CHARS.length - 1));
      return SPARK_CHARS[Math.max(0, Math.min(SPARK_CHARS.length - 1, idx))];
    })
    .join("");

  return (
    <Box flexDirection="row">
      {label && (
        <Box width={12}>
          <Text color={T.muted}>{label}</Text>
        </Box>
      )}
      <Text color={T.accent}>{spark}</Text>
      <Box marginLeft={1}>
        <Text color={T.muted}>
          {formatNum(min)}–{formatNum(max)}
        </Text>
      </Box>
    </Box>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}
