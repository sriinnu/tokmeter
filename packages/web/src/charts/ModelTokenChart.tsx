import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
} from "../components/ui/chart.js";
import type { TokmeterModelSummary } from "../hooks/useTokmeterData.js";
import { formatCompact, formatInteger } from "../lib/format.js";
import { useMotion } from "../lib/motion.js";
import { TOKEN_BUCKETS, TOKEN_CONFIG } from "./token-buckets.js";

/** Horizontal stacked token buckets per model, largest volume first. */
export function ModelTokenChart({ models }: { models: TokmeterModelSummary[] }) {
  // Charts grow in (and morph on refresh) only when motion is on.
  const { enabled: animate } = useMotion();
  const height = Math.max(160, models.length * 30 + 40);
  return (
    <div className="grid gap-2">
      <ChartContainer config={TOKEN_CONFIG} style={{ height }}>
        <BarChart
          data={models}
          layout="vertical"
          margin={{ top: 4, right: 8, bottom: 0, left: 0 }}
          barCategoryGap="22%"
        >
          <CartesianGrid horizontal={false} />
          <XAxis
            type="number"
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => formatCompact(v)}
          />
          <YAxis
            type="category"
            dataKey="model"
            width={128}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: string) => (v.length > 20 ? `${v.slice(0, 19)}…` : v)}
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", opacity: 0.6 }}
            content={({ active, payload, label }) => (
              <ChartTooltipContent
                active={active}
                payload={payload as never}
                label={label as string}
                hideZero
                valueFormatter={(v) => formatInteger(v)}
              />
            )}
          />
          {TOKEN_BUCKETS.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="m"
              fill={`var(--color-${key})`}
              stroke="var(--card)"
              strokeWidth={1}
              radius={index === TOKEN_BUCKETS.length - 1 ? [0, 3, 3, 0] : 0}
              isAnimationActive={animate}
              animationDuration={500}
              animationEasing="ease-out"
            />
          ))}
        </BarChart>
      </ChartContainer>
      <ChartLegend config={TOKEN_CONFIG} />
    </div>
  );
}
