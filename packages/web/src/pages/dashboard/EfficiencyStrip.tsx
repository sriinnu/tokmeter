import { Card } from "../../components/ui/card.js";
import type { DashboardInsights } from "./buildDashboardInsights.js";

const SHOWN = ["Cache share", "Reasoning share", "Cost / 1M tokens", "Longest streak", "Projects"];

/** Secondary all-time ratios, one dense row under the headline tiles. */
export function EfficiencyStrip({ insights }: { insights: DashboardInsights }) {
  const kpis = SHOWN.map((label) => insights.kpis.find((kpi) => kpi.label === label)).filter(
    (kpi) => kpi !== undefined
  );
  return (
    <Card>
      <dl className="grid grid-cols-2 divide-y sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-5 lg:divide-x">
        {kpis.map((kpi) => (
          <div key={kpi.label} className="min-w-0 px-4 py-3">
            <dt className="text-xs text-muted-foreground">
              {kpi.label === "Cost / 1M tokens" ? "Est. cost / 1M tokens" : kpi.label}
            </dt>
            <dd className="num mt-0.5 text-lg font-semibold">{kpi.value}</dd>
            <dd className="truncate text-xs text-muted-foreground" title={kpi.helper}>
              {kpi.helper}
            </dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
