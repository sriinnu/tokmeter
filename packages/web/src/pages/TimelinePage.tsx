import { useState } from "react";
import { ContributionHeatmap } from "../charts/ContributionHeatmap.js";
import { DataGate } from "../components/DataGate.js";
import { EstimateNote } from "../components/EstimateNote.js";
import { KpiTile } from "../components/KpiTile.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState } from "../components/states.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import type { TokmeterData } from "../hooks/useTokmeterData.js";
import { localDateKey } from "../lib/dates.js";
import { formatCurrency, formatInteger, formatLongDate, formatShortDate } from "../lib/format.js";
import type { Metric } from "../lib/series.js";
import { DailySpendCard } from "./dashboard/DailySpendCard.js";
import { DailyLedgerTable } from "./timeline/DailyLedgerTable.js";
import { MonthlyTable } from "./timeline/MonthlyTable.js";

export function TimelinePage() {
  return <DataGate>{(data) => <TimelineView data={data} />}</DataGate>;
}

function TimelineView({ data }: { data: TokmeterData }) {
  const todayKey = localDateKey(Date.now());
  const [heatMetric, setHeatMetric] = useState<Metric>("cost");
  const { daily, stats, meta } = data;
  const peak = daily.reduce<(typeof daily)[number] | null>(
    (best, d) => (!best || d.cost > best.cost ? d : best),
    null
  );
  const avg = stats.activeDays > 0 ? stats.totalCost / stats.activeDays : 0;

  return (
    <>
      <PageHeader
        title="Timeline"
        description={
          daily.length > 0
            ? `${formatShortDate(daily[0].date)} – ${formatShortDate(daily[daily.length - 1].date)}`
            : "No history yet"
        }
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <KpiTile
          label="Active days"
          value={{ value: stats.activeDays, format: formatInteger }}
          secondary={`${formatInteger(stats.totalRecords)} records`}
        />
        <KpiTile
          label="Longest streak"
          value={`${stats.longestStreak}d`}
          secondary="Consecutive active days"
        />
        <KpiTile
          label="Avg / active day"
          value={{ value: avg, format: formatCurrency }}
          secondary="Est. cost, all time"
        />
        <KpiTile
          label="Peak day"
          value={peak ? formatCurrency(peak.cost) : "—"}
          secondary={peak ? formatLongDate(peak.date) : "No history yet"}
        />
      </div>
      {daily.length === 0 ? (
        <EmptyState title="No daily history yet" />
      ) : (
        <>
          <DailySpendCard
            daily={daily}
            meta={meta}
            todayKey={todayKey}
            defaultWindow="90"
            storageKey="tokmeter.range.timeline"
          />
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Last 12 months</CardTitle>
                <CardDescription>One cell per day · hover a cell for its value</CardDescription>
              </div>
              <ToggleGroup
                type="single"
                value={heatMetric}
                onValueChange={(value) => value && setHeatMetric(value as Metric)}
                aria-label="Heatmap measure"
              >
                <ToggleGroupItem value="cost">Cost</ToggleGroupItem>
                <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
              </ToggleGroup>
            </CardHeader>
            <CardContent>
              <ContributionHeatmap daily={daily} todayKey={todayKey} metric={heatMetric} />
            </CardContent>
          </Card>
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>By month</CardTitle>
                  <CardDescription>Sums of the daily ledger</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-1 sm:px-0">
                <MonthlyTable daily={daily} todayKey={todayKey} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Daily ledger</CardTitle>
                  <CardDescription>Sealed days are immutable; today is live</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="px-0 pb-1 sm:px-0">
                <DailyLedgerTable daily={daily} meta={meta} todayKey={todayKey} />
              </CardContent>
            </Card>
          </div>
        </>
      )}
      <EstimateNote />
    </>
  );
}
