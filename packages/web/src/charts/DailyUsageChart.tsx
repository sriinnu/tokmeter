import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import {
  ChartContainer,
  ChartLegend,
  ChartTooltip,
  ChartTooltipContent,
} from "../components/ui/chart.js";
import { DAY_STATE_LABEL } from "../lib/day-state.js";
import {
  formatAxisCurrency,
  formatCompact,
  formatCurrency,
  formatInteger,
  formatLongDate,
  formatShortDate,
} from "../lib/format.js";
import { useMotion } from "../lib/motion.js";
import type { ChartPoint } from "../lib/rollup.js";
import type { Metric } from "../lib/series.js";
import { COST_CONFIG, TOKEN_BUCKETS, TOKEN_CONFIG } from "./token-buckets.js";

/**
 * Daily (or, for long ranges, weekly) cost as one series, or token
 * composition as five stacked buckets. One measure per chart, never a second
 * y-axis. Periods that can still change (today, unsealed) are drawn at
 * reduced opacity and say so in the legend and the tooltip, so live numbers
 * never pass for sealed ones. Weeks cut by the range edge get a dashed
 * outline and say "partial" in the tooltip.
 */
export function DailyUsageChart({
  points,
  metric,
  height = 260,
}: {
  points: ChartPoint[];
  metric: Metric;
  height?: number;
}) {
  // Charts grow in (and morph on refresh) only when motion is on.
  const { enabled: animate } = useMotion();
  const config = metric === "cost" ? COST_CONFIG : TOKEN_CONFIG;
  const keys = metric === "cost" ? ["cost"] : [...TOKEN_BUCKETS];
  const anyOpen = points.some((point) => point.state !== "sealed");
  const weekly = points[0]?.granularity === "week";
  const anyPartial = points.some((point) => point.partial);

  return (
    <div className="grid gap-2">
      <ChartContainer config={config} style={{ height }}>
        <BarChart
          data={points}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          barCategoryGap="12%"
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="date"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            minTickGap={28}
            tickFormatter={(value: string) => formatShortDate(value)}
          />
          <YAxis
            width={52}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) =>
              metric === "cost" ? formatAxisCurrency(value) : formatCompact(value)
            }
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", opacity: 0.6 }}
            content={({ active, payload, label }) => (
              <ChartTooltipContent
                active={active}
                payload={payload as never}
                label={label as string}
                hideZero={metric === "tokens"}
                labelFormatter={(value, rows) => {
                  const point = rows[0]?.payload as ChartPoint | undefined;
                  return (
                    <span className="flex items-center justify-between gap-3">
                      {point?.granularity === "week"
                        ? `Week of ${formatShortDate(point.date)} – ${formatShortDate(point.end)}`
                        : formatLongDate(value)}
                      {point && (
                        <span className="font-normal text-muted-foreground">
                          {point.partial ? `partial · ${point.days} of 7 days · ` : ""}
                          {DAY_STATE_LABEL[point.state]}
                        </span>
                      )}
                    </span>
                  );
                }}
                valueFormatter={(value) =>
                  metric === "cost" ? formatCurrency(value) : formatInteger(value)
                }
                footer={(rows) => {
                  const point = rows[0]?.payload as ChartPoint | undefined;
                  if (!point) return null;
                  return (
                    <div className="mt-1.5 flex justify-between gap-4 border-t pt-1.5 text-muted-foreground">
                      <span>{metric === "cost" ? "Tokens" : "Est. cost"}</span>
                      <span className="num text-foreground">
                        {metric === "cost"
                          ? formatInteger(point.totalTokens)
                          : formatCurrency(point.cost)}
                      </span>
                    </div>
                  );
                }}
              />
            )}
          />
          {keys.map((key, index) => (
            <Bar
              key={key}
              dataKey={key}
              stackId="day"
              fill={`var(--color-${key})`}
              radius={index === keys.length - 1 ? [3, 3, 0, 0] : 0}
              isAnimationActive={animate}
              animationDuration={500}
              animationEasing="ease-out"
              stroke="var(--card)"
              strokeWidth={metric === "tokens" ? 1 : 0}
            >
              {points.map((point) => (
                <Cell
                  key={point.date}
                  fillOpacity={point.state === "sealed" ? 1 : 0.45}
                  stroke={point.partial ? "var(--muted-foreground)" : undefined}
                  strokeDasharray={point.partial ? "3 2" : undefined}
                  strokeWidth={point.partial ? 1 : undefined}
                />
              ))}
            </Bar>
          ))}
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {metric === "tokens" ? (
          <ChartLegend config={TOKEN_CONFIG} />
        ) : (
          <span className="text-xs text-muted-foreground">
            {weekly ? "Weekly totals (Mon–Sun)" : "Per day"}
          </span>
        )}
        {anyPartial && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span
              aria-hidden
              className="size-2.5 rounded-[3px] border border-dashed border-muted-foreground"
            />
            Dashed: partial week at the range edge
          </span>
        )}
        {anyOpen && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span aria-hidden className="size-2.5 rounded-[3px] bg-series-1 opacity-45" />
            Faded: {weekly ? "week with today or unsealed days" : "today or not yet sealed"} — can
            still change
          </span>
        )}
      </div>
    </div>
  );
}
