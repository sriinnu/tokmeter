import { useState } from "react";
import { Link } from "react-router-dom";
import { BarList } from "../../charts/BarList.js";
import { EmptyState } from "../../components/states.js";
import { Button } from "../../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import { ToggleGroup, ToggleGroupItem } from "../../components/ui/toggle-group.js";
import {
  formatCompact,
  formatCostPerMillion,
  formatCurrency,
  formatPercent,
  plural,
} from "../../lib/format.js";
import type { DashboardInsights } from "./buildDashboardInsights.js";

export function ProvidersCard({ insights }: { insights: DashboardInsights }) {
  const providers = insights.providerInsights;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Providers</CardTitle>
          <CardDescription>Share of estimated cost, all time</CardDescription>
        </div>
      </CardHeader>
      <CardContent>
        {providers.length === 0 ? (
          <EmptyState title="No provider history yet" />
        ) : (
          <BarList
            label="Providers by estimated cost"
            items={providers.map((p) => ({
              key: p.provider,
              label: p.provider,
              value: p.cost,
              valueText: formatCurrency(p.cost),
              detail: `${formatPercent(p.percentageOfTotal / 100)} · ${formatCompact(p.totalTokens)} tokens · ${formatCostPerMillion(p.costPerMillion)} · ${plural(p.projectCount, "project")}`,
            }))}
          />
        )}
      </CardContent>
    </Card>
  );
}

export function ModelsCard({ insights }: { insights: DashboardInsights }) {
  const [scope, setScope] = useState<"all" | "today">("all");
  const models = scope === "all" ? insights.topModels : insights.todayModels.slice(0, 8);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Top models</CardTitle>
          <CardDescription>By estimated cost</CardDescription>
        </div>
        <ToggleGroup
          type="single"
          value={scope}
          onValueChange={(value) => value && setScope(value as "all" | "today")}
          aria-label="Model scope"
        >
          <ToggleGroupItem value="all">All time</ToggleGroupItem>
          <ToggleGroupItem value="today">Today</ToggleGroupItem>
        </ToggleGroup>
      </CardHeader>
      <CardContent className="grid gap-3">
        {models.length === 0 ? (
          <EmptyState title={scope === "today" ? "No models used today" : "No model history yet"} />
        ) : (
          <BarList
            label={`Top models by estimated cost, ${scope === "all" ? "all time" : "today"}`}
            items={models.map((m) => ({
              key: `${m.provider}:${m.model}`,
              label: m.model,
              value: m.cost,
              valueText: formatCurrency(m.cost),
              detail: `${m.provider} · ${formatCompact(m.totalTokens)} tokens · ${formatPercent(m.percentageOfTotal / 100)} of ${scope === "all" ? "total" : "today"}`,
            }))}
          />
        )}
        <Button asChild variant="link" size="sm" className="justify-self-start px-0">
          <Link to="/models">All models</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
