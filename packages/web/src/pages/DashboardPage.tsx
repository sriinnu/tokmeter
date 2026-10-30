import { useMemo } from "react";
import { AmbientBand } from "../ambient/AmbientBand.js";
import { DataGate } from "../components/DataGate.js";
import { EstimateNote } from "../components/EstimateNote.js";
import { PageHeader } from "../components/PageHeader.js";
import type { TokmeterData } from "../hooks/useTokmeterData.js";
import { useDashboardData } from "../lib/data-context.js";
import { localDateKey } from "../lib/dates.js";
import { formatTimestamp } from "../lib/format.js";
import { buildPeriodTotals } from "../lib/periods.js";
import { computeSpendTempo } from "../lib/tempo.js";
import { ModelsCard, ProvidersCard } from "./dashboard/BreakdownCards.js";
import { buildDashboardInsights } from "./dashboard/buildDashboardInsights.js";
import { DailySpendCard } from "./dashboard/DailySpendCard.js";
import { EfficiencyStrip } from "./dashboard/EfficiencyStrip.js";
import { LiveSessionsCard } from "./dashboard/LiveSessionsCard.js";
import { PeriodTiles } from "./dashboard/PeriodTiles.js";
import { TodayCard } from "./dashboard/TodayCard.js";
import { TopProjectsCard } from "./dashboard/TopProjectsCard.js";

export function DashboardPage() {
  return <DataGate>{(data) => <Overview data={data} />}</DataGate>;
}

function Overview({ data }: { data: TokmeterData }) {
  const { live } = useDashboardData();
  const todayKey = localDateKey(Date.now());
  const sessions = live.aggregated?.sessions ?? 0;
  // The live stream ticks every 2s; only its status and session count feed
  // the insights, so the ledger charts don't re-render on every tick.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately keyed on status/sessions
  const insights = useMemo(() => buildDashboardInsights(data, live), [data, live.status, sessions]);
  const periods = useMemo(() => buildPeriodTotals(data.daily, data.stats), [data]);
  const tempo = useMemo(() => computeSpendTempo(data.daily, data.meta), [data]);

  const ledger = useMemo(
    () => (
      <>
        <PeriodTiles data={data} periods={periods} today={insights.today} todayKey={todayKey} />
        <EfficiencyStrip insights={insights} />
        <DailySpendCard
          daily={data.daily}
          meta={data.meta}
          todayKey={todayKey}
          storageKey="tokmeter.range.overview"
        />
        <div className="grid gap-5 lg:grid-cols-2">
          <TodayCard insights={insights} records={data.records} timeOfDay={data.timeOfDay} />
          <ProvidersCard insights={insights} />
          <ModelsCard insights={insights} />
          <TopProjectsCard insights={insights} />
        </div>
      </>
    ),
    [data, insights, periods, todayKey]
  );

  return (
    <>
      <AmbientBand tempo={tempo}>
        <PageHeader
          title="Overview"
          description={
            data.stats.lastUsed
              ? `Last activity ${formatTimestamp(data.stats.lastUsed)} · ${data.stats.projects} projects · ${data.stats.providers} providers`
              : "Waiting for the first tracked request"
          }
        />
      </AmbientBand>
      {ledger}
      <LiveSessionsCard live={live} />
      <EstimateNote />
    </>
  );
}
