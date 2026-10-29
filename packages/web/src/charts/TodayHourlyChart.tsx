import { Bar, BarChart, CartesianGrid, Cell, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "../components/ui/chart.js";
import {
  formatAxisCurrency,
  formatCompact,
  formatCurrency,
  formatHour,
  formatInteger,
} from "../lib/format.js";
import { useMotion } from "../lib/motion.js";
import type { DashboardTodayHour } from "../pages/dashboard/buildDashboardInsights.js";

/**
 * Today's activity by local hour. Bars encode ONE measure: cost by default;
 * when every record today is unpriced (subscription/local models) the whole
 * series switches to tokens and says so, rather than mixing dollars and token
 * counts on one axis.
 */
export function TodayHourlyChart({
  hours,
  height = 200,
}: {
  hours: DashboardTodayHour[];
  height?: number;
}) {
  // Charts grow in (and morph on refresh) only when motion is on.
  const { enabled: animate } = useMotion();
  const usesTokens = hours.every((h) => h.cost === 0) && hours.some((h) => h.totalTokens > 0);
  const key = usesTokens ? "totalTokens" : "cost";
  const nowHour = new Date().getHours();
  const config = {
    [key]: { label: usesTokens ? "Tokens" : "Est. cost", color: "var(--series-1)" },
  };

  return (
    <div className="grid gap-2">
      <ChartContainer config={config} style={{ height }}>
        <BarChart
          data={hours}
          margin={{ top: 8, right: 4, bottom: 0, left: 0 }}
          barCategoryGap="14%"
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="hour"
            tickLine={false}
            axisLine={false}
            tickMargin={6}
            ticks={[0, 6, 12, 18, 23]}
            tickFormatter={(hour: number) => formatHour(hour)}
          />
          <YAxis
            width={52}
            tickLine={false}
            axisLine={false}
            tickFormatter={(value: number) =>
              usesTokens ? formatCompact(value) : formatAxisCurrency(value)
            }
          />
          <ChartTooltip
            cursor={{ fill: "var(--muted)", opacity: 0.6 }}
            content={({ active, payload, label }) => (
              <ChartTooltipContent
                active={active}
                payload={payload as never}
                label={label as number}
                labelFormatter={(hour) =>
                  `${formatHour(Number(hour))} – ${formatHour(Number(hour) + 1)}`
                }
                valueFormatter={(value) =>
                  usesTokens ? formatInteger(value) : formatCurrency(value)
                }
                footer={(rows) => {
                  const bucket = rows[0]?.payload as DashboardTodayHour | undefined;
                  if (!bucket) return null;
                  return (
                    <div className="mt-1.5 grid gap-0.5 border-t pt-1.5 text-muted-foreground">
                      {!usesTokens && (
                        <Row label="Tokens" value={formatInteger(bucket.totalTokens)} />
                      )}
                      <Row label="Records" value={formatInteger(bucket.records)} />
                      {bucket.topModel && <Row label="Top model" value={bucket.topModel} />}
                    </div>
                  );
                }}
              />
            )}
          />
          <Bar
            dataKey={key}
            fill={`var(--color-${key})`}
            radius={[3, 3, 0, 0]}
            isAnimationActive={animate}
            animationDuration={500}
            animationEasing="ease-out"
          >
            {hours.map((bucket) => (
              <Cell
                key={bucket.hour}
                fillOpacity={bucket.hour === nowHour ? 0.5 : 1}
                stroke={bucket.hour === nowHour ? "var(--foreground)" : undefined}
                strokeWidth={bucket.hour === nowHour ? 1 : 0}
              />
            ))}
          </Bar>
        </BarChart>
      </ChartContainer>
      <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>
          {usesTokens ? "Tokens per hour — nothing priced today" : "Estimated cost per local hour"}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-[3px] border border-foreground bg-series-1/50"
          />
          Current hour, still filling
        </span>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{label}</span>
      <span className="max-w-44 truncate text-foreground">{value}</span>
    </div>
  );
}
