import { useMemo } from "react";
import { BarList } from "../../charts/BarList.js";
import { seriesColor, TodayDial } from "../../charts/TodayDial.js";
import { TodayHourlyChart } from "../../charts/TodayHourlyChart.js";
import { EmptyState } from "../../components/states.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../components/ui/table.js";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.js";
import { useStoredState } from "../../hooks/useStoredState.js";
import type { TokmeterTimeOfDay } from "../../hooks/useTokmeterData.js";
import { localDateKey } from "../../lib/dates.js";
import {
  formatCompact,
  formatCurrency,
  formatHour,
  formatInteger,
  formatLongDate,
} from "../../lib/format.js";
import { buildTodayDial, buildTypicalDay, OTHER_KEY } from "../../lib/today-dial.js";
import type { DashboardInsights } from "./buildDashboardInsights.js";
import { TimeOfDayStrip } from "./TimeOfDayStrip.js";

const VIEWS = ["dial", "bars", "table"] as const;
type View = (typeof VIEWS)[number];
const isView = (value: string): value is View => (VIEWS as readonly string[]).includes(value);

/**
 * Today hour by hour, three ways over the same numbers: a 24-hour dial (the
 * default), the bar chart, and a table. The models list doubles as the dial's
 * colour legend.
 */
export function TodayCard({
  insights,
  records,
  timeOfDay,
}: {
  insights: DashboardInsights;
  records: Array<Record<string, unknown>>;
  /** The daemon's 30-day cost share per 3-hour block; absent from older daemons. */
  timeOfDay?: TokmeterTimeOfDay;
}) {
  const today = insights.today;
  const [view, setView] = useStoredState<View>("tokmeter.today.view", "dial", isView);
  const dial = useMemo(
    () => buildTodayDial(records, today.date, localDateKey),
    [records, today.date]
  );
  const typical = useMemo(
    () => buildTypicalDay(records, today.date, localDateKey, dial.measure),
    [records, today.date, dial.measure]
  );
  const hourlyRecords = today.hourly.reduce((sum, h) => sum + h.records, 0);
  // Rank by cost; on an all-unpriced day fall back to tokens so a "$0.00"
  // model isn't crowned by insertion order.
  const priced = insights.todayModels.some((m) => m.cost > 0);
  const models = [...insights.todayModels]
    .sort((a, b) => (priced ? b.cost - a.cost : b.totalTokens - a.totalTokens))
    .slice(0, 6);
  const swatch = (key: string) =>
    seriesColor(dial, dial.series.some((s) => s.key === key) ? key : OTHER_KEY);

  return (
    <Card className="lg:col-span-2">
      <CardHeader>
        <div>
          <CardTitle>Today, hour by hour</CardTitle>
          <CardDescription>
            {formatLongDate(today.date)} · {formatCurrency(today.cost)} est. ·{" "}
            {formatInteger(today.totalTokens)} tokens · {formatInteger(today.records)} records
          </CardDescription>
        </div>
        {hourlyRecords > 0 && (
          <ToggleGroup
            type="single"
            value={view}
            onValueChange={(value) => value && isView(value) && setView(value)}
            aria-label="Today view"
          >
            <ToggleGroupItem value="dial">Dial</ToggleGroupItem>
            <ToggleGroupItem value="bars">Bars</ToggleGroupItem>
            <ToggleGroupItem value="table">Table</ToggleGroupItem>
          </ToggleGroup>
        )}
      </CardHeader>
      <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        {!today.hasActivity ? (
          <EmptyState
            art="empty"
            title="No activity yet today"
            message="The dial wakes up with the first tracked request of the day."
          />
        ) : hourlyRecords === 0 ? (
          // Totals can exist without an hourly curve: the raw records window
          // feeds the buckets, and a summary without records (stripped static
          // export, writer-TZ mismatch) would otherwise draw an empty clock
          // under a real headline.
          <EmptyState
            title="Hourly breakdown unavailable"
            message="This summary has no raw records for today. The totals above are still accurate."
          />
        ) : view === "dial" ? (
          <TodayDial dial={dial} typical={typical} ledgerCost={today.cost} />
        ) : view === "bars" ? (
          <TodayHourlyChart hours={today.hourly} />
        ) : (
          <HourTable insights={insights} />
        )}
        <div className="grid content-start gap-3">
          <h3 className="text-xs font-medium text-muted-foreground">Models today</h3>
          {models.length > 0 ? (
            <BarList
              label="Models used today"
              items={models.map((m) => ({
                key: `${m.provider}::${m.model}`,
                label: m.model,
                value: priced ? m.cost : m.totalTokens,
                valueText: priced ? formatCurrency(m.cost) : `${formatCompact(m.totalTokens)} tok`,
                detail: `${m.provider} · ${formatCompact(m.totalTokens)} tokens${m.cost === 0 ? " · unpriced" : ""}`,
                swatch: view === "dial" ? swatch(`${m.provider}::${m.model}`) : undefined,
              }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No models yet today.</p>
          )}
          <TimeOfDayStrip profile={timeOfDay} />
        </div>
      </CardContent>
    </Card>
  );
}

function HourTable({ insights }: { insights: DashboardInsights }) {
  return (
    <div className="max-h-96 overflow-y-auto rounded-lg border">
      <Table>
        <TableHeader className="sticky top-0 bg-card">
          <TableRow>
            <TableHead>Hour</TableHead>
            <TableHead className="text-right">Est. cost</TableHead>
            <TableHead className="text-right">Tokens</TableHead>
            <TableHead className="text-right">Records</TableHead>
            <TableHead>Top model</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {insights.today.hourly
            .filter((h) => h.records > 0)
            .map((h) => (
              <TableRow key={h.hour}>
                <TableCell>
                  {formatHour(h.hour)}–{formatHour(h.hour + 1)}
                </TableCell>
                <TableCell className="num text-right">{formatCurrency(h.cost)}</TableCell>
                <TableCell className="num text-right">{formatInteger(h.totalTokens)}</TableCell>
                <TableCell className="num text-right">{formatInteger(h.records)}</TableCell>
                <TableCell className="max-w-48 truncate">{h.topModel ?? "—"}</TableCell>
              </TableRow>
            ))}
        </TableBody>
      </Table>
    </div>
  );
}
