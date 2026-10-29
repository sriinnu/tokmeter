import { DayStateBadge } from "../../components/DayStateBadge.js";
import { KpiTile } from "../../components/KpiTile.js";
import { Badge } from "../../components/ui/badge.js";
import type { TokmeterData } from "../../hooks/useTokmeterData.js";
import { getDayState } from "../../lib/day-state.js";
import {
  formatCompact,
  formatCurrency,
  formatInteger,
  formatShortDate,
  plural,
} from "../../lib/format.js";
import type { PeriodTotals } from "../../lib/periods.js";
import type { DashboardTodayInsight } from "./buildDashboardInsights.js";

/** Today (live), week-to-date, month-to-date and all-time, cost first. */
export function PeriodTiles({
  data,
  periods,
  today,
  todayKey,
}: {
  data: TokmeterData;
  periods: Record<"today" | "week" | "month" | "all", PeriodTotals>;
  today: DashboardTodayInsight;
  todayKey: string;
}) {
  const yesterday = periods.today.previous;
  const tokensLine = (p: PeriodTotals) => `${formatCompact(p.totalTokens)} tokens`;
  const tokensLabel = (p: PeriodTotals) => `${formatInteger(p.totalTokens)} tokens`;

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <KpiTile
        label="Today"
        hint="Today's ledger entry. Live while the daemon refreshes it; it seals after midnight and never shrinks afterwards."
        badge={<DayStateBadge state={getDayState(todayKey, todayKey, data.meta)} />}
        value={{ value: periods.today.cost, format: formatCurrency }}
        secondary={<span title={tokensLabel(periods.today)}>{tokensLine(periods.today)}</span>}
        series={
          today.hourly.some((h) => h.records > 0) ? today.hourly.map((h) => h.cost) : undefined
        }
        footnote={yesterday ? `Yesterday ${formatCurrency(yesterday.cost)} (full day)` : undefined}
      />
      <KpiTile
        label="This week"
        hint="Sum of daily ledger entries from Monday through today. The comparison uses the same weekdays of last week."
        badge={<Badge variant="outline">Mon – today</Badge>}
        value={{ value: periods.week.cost, format: formatCurrency }}
        secondary={tokensLine(periods.week)}
        series={periods.week.series}
        compare={
          periods.week.previous
            ? {
                current: periods.week.cost,
                previous: periods.week.previous.cost,
                label: "vs same days last week",
                previousText: formatCurrency(periods.week.previous.cost),
              }
            : undefined
        }
      />
      <KpiTile
        label="This month"
        hint="Sum of daily ledger entries since the 1st. The comparison uses the same days of last month."
        badge={<Badge variant="outline">Month to date</Badge>}
        value={{ value: periods.month.cost, format: formatCurrency }}
        secondary={tokensLine(periods.month)}
        series={periods.month.series}
        compare={
          periods.month.previous
            ? {
                current: periods.month.cost,
                previous: periods.month.previous.cost,
                label: "vs same days last month",
                previousText: formatCurrency(periods.month.previous.cost),
              }
            : undefined
        }
      />
      <KpiTile
        label="All time"
        hint="Straight from the summary's stats, not re-summed here. Sparkline is the last 30 days."
        badge={<Badge variant="outline">{plural(periods.all.activeDays, "active day")}</Badge>}
        value={{ value: periods.all.cost, format: formatCurrency }}
        secondary={tokensLine(periods.all)}
        series={periods.all.series}
        footnote={
          periods.all.start
            ? `Since ${formatShortDate(periods.all.start)} · last 30 days shown`
            : "No history yet"
        }
      />
    </div>
  );
}
