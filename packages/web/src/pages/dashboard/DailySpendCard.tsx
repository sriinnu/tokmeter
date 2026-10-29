import { useMemo, useState } from "react";
import { DailyUsageChart } from "../../charts/DailyUsageChart.js";
import { ChartFigure } from "../../components/ChartFigure.js";
import { DayStateBadge } from "../../components/DayStateBadge.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.js";
import { useStoredState } from "../../hooks/useStoredState.js";
import type { TokmeterDailyEntry, TokmeterScanMeta } from "../../hooks/useTokmeterData.js";
import { formatCurrency, formatInteger, formatShortDate } from "../../lib/format.js";
import { toChartPoints } from "../../lib/rollup.js";
import { buildDailySeries, type Metric, spanDays } from "../../lib/series.js";

const WINDOWS = ["30", "90", "180", "all"] as const;
type Window = (typeof WINDOWS)[number];
const isWindow = (value: string): value is Window => (WINDOWS as readonly string[]).includes(value);
// Ten years is far beyond any ledger; it only bounds a corrupt first date.
const ALL_CAP_DAYS = 3660;

/**
 * Daily spend or token composition over a chosen window. Shared by the
 * overview, the timeline and project detail, each passing its own ledger.
 */
export function DailySpendCard({
  title = "Daily usage",
  description,
  daily,
  meta,
  todayKey,
  defaultWindow = "30",
  storageKey,
}: {
  title?: string;
  description?: string;
  daily: TokmeterDailyEntry[];
  meta: TokmeterScanMeta;
  todayKey: string;
  defaultWindow?: Window;
  /** Remembers the chosen range per chart in this browser. */
  storageKey?: string;
}) {
  const [range, setRange] = useStoredState<Window>(storageKey, defaultWindow, isWindow);
  const windowDays = range === "all" ? spanDays(daily, todayKey, ALL_CAP_DAYS) : Number(range);
  const [metric, setMetric] = useState<Metric>("cost");
  const points = useMemo(
    () => buildDailySeries(daily, windowDays, todayKey, todayKey, meta),
    [daily, windowDays, todayKey, meta]
  );
  const chartPoints = useMemo(() => toChartPoints(points), [points]);
  const rangeLabel = range === "all" ? `all ${windowDays} days` : `${windowDays} days`;
  const windowCost = points.reduce((sum, p) => sum + p.cost, 0);
  const windowTokens = points.reduce((sum, p) => sum + p.totalTokens, 0);
  const active = points.filter((p) => p.hasEntry).length;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          <CardDescription>
            {description ??
              `${formatCurrency(windowCost)} est. · ${formatInteger(windowTokens)} tokens over ${rangeLabel} (${active} active)${chartPoints[0]?.granularity === "week" ? " · weekly bars" : ""}`}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        <ChartFigure
          label={`${title}, ${range === "all" ? "all time" : `last ${windowDays} days`}`}
          summary={`${metric === "cost" ? "Estimated cost" : "Tokens"} per ${chartPoints[0]?.granularity === "week" ? "week" : "day"}. ${formatCurrency(windowCost)} and ${formatInteger(windowTokens)} tokens in total across ${active} active days.`}
          toolbar={
            <>
              <ToggleGroup
                type="single"
                value={metric}
                onValueChange={(value) => value && setMetric(value as Metric)}
                aria-label="Measure"
              >
                <ToggleGroupItem value="cost">Cost</ToggleGroupItem>
                <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
              </ToggleGroup>
              <ToggleGroup
                type="single"
                value={range}
                onValueChange={(value) => value && isWindow(value) && setRange(value)}
                aria-label="Range"
              >
                {WINDOWS.map((w) => (
                  <ToggleGroupItem
                    key={w}
                    value={w}
                    aria-label={w === "all" ? "All time" : `Last ${w} days`}
                  >
                    {w === "all" ? "All" : `${w}d`}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </>
          }
          table={{
            columns: [
              { label: "Date" },
              { label: "State" },
              { label: "Est. cost", align: "right" },
              { label: "Tokens", align: "right" },
              { label: "Records", align: "right" },
            ],
            rows: [...points].reverse().map((p) => ({
              key: p.date,
              cells: [
                formatShortDate(p.date),
                <DayStateBadge key="s" state={p.state} />,
                formatCurrency(p.cost),
                formatInteger(p.totalTokens),
                formatInteger(p.records),
              ],
            })),
          }}
        >
          <DailyUsageChart points={chartPoints} metric={metric} />
        </ChartFigure>
      </CardContent>
    </Card>
  );
}
