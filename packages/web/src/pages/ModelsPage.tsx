import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { BarList } from "../charts/BarList.js";
import { ModelTokenChart } from "../charts/ModelTokenChart.js";
import { ChartFigure } from "../components/ChartFigure.js";
import { DataGate } from "../components/DataGate.js";
import { EstimateNote } from "../components/EstimateNote.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState } from "../components/states.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { NativeSelect } from "../components/ui/native-select.js";
import type { TokmeterData } from "../hooks/useTokmeterData.js";
import { useDashboardData } from "../lib/data-context.js";
import {
  formatCompact,
  formatCostPerMillion,
  formatCurrency,
  formatInteger,
  formatPercent,
  plural,
} from "../lib/format.js";
import { buildDashboardInsights } from "./dashboard/buildDashboardInsights.js";
import { ModelTable } from "./models/ModelTable.js";

const ALL = "__all__";
const CHART_TOP = 12;

export function ModelsPage() {
  return <DataGate>{(data) => <ModelsView data={data} />}</DataGate>;
}

function ModelsView({ data }: { data: TokmeterData }) {
  const { live } = useDashboardData();
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState(ALL);
  // biome-ignore lint/correctness/useExhaustiveDependencies: provider totals don't depend on live ticks
  const providers = useMemo(() => buildDashboardInsights(data, live).providerInsights, [data]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.models.filter(
      (m) =>
        (!needle || m.model.toLowerCase().includes(needle)) &&
        (provider === ALL || m.provider === provider)
    );
  }, [data.models, query, provider]);
  const byCost = useMemo(() => [...filtered].sort((a, b) => b.cost - a.cost), [filtered]);
  const byTokens = useMemo(
    () => [...filtered].sort((a, b) => b.totalTokens - a.totalTokens).slice(0, CHART_TOP),
    [filtered]
  );
  const providerNames = useMemo(
    () => [...new Set(data.models.map((m) => m.provider))].sort(),
    [data.models]
  );

  return (
    <>
      <PageHeader
        title="Models"
        description={`${plural(data.models.length, "model")} across ${plural(providerNames.length, "provider")}`}
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-1 basis-56">
          <Search
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter models"
            aria-label="Filter models by name"
            className="pl-8"
          />
        </div>
        <NativeSelect
          value={provider}
          onChange={(event) => setProvider(event.target.value)}
          aria-label="Filter by provider"
          className="w-full sm:w-48"
        >
          <option value={ALL}>All providers</option>
          {providerNames.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </NativeSelect>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title={data.models.length === 0 ? "No model usage yet" : "No models match"} />
      ) : (
        <div className="grid gap-5 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Est. cost by model</CardTitle>
                <CardDescription>
                  Top {Math.min(CHART_TOP, byCost.length)} of {byCost.length}, all time
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <BarList
                label="Models by estimated cost"
                items={byCost.slice(0, CHART_TOP).map((m) => ({
                  key: `${m.provider}:${m.model}`,
                  label: m.model,
                  value: m.cost,
                  valueText: formatCurrency(m.cost),
                  detail: `${m.provider} · ${formatPercent(m.percentageOfTotal / 100)} of all spend`,
                }))}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Where the tokens go</CardTitle>
                <CardDescription>Top {byTokens.length} by volume, split by bucket</CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <ChartFigure
                label="Token buckets by model"
                summary={`Stacked input, output, cache read, cache write and reasoning tokens for the ${byTokens.length} largest models.`}
                table={{
                  columns: [
                    { label: "Model" },
                    { label: "Input", align: "right" },
                    { label: "Output", align: "right" },
                    { label: "Cache read", align: "right" },
                    { label: "Cache write", align: "right" },
                    { label: "Reasoning", align: "right" },
                    { label: "Total", align: "right" },
                  ],
                  rows: byTokens.map((m) => ({
                    key: `${m.provider}:${m.model}`,
                    cells: [
                      m.model,
                      formatInteger(m.inputTokens),
                      formatInteger(m.outputTokens),
                      formatInteger(m.cacheReadTokens),
                      formatInteger(m.cacheWriteTokens),
                      formatInteger(m.reasoningTokens),
                      formatInteger(m.totalTokens),
                    ],
                  })),
                }}
              >
                <ModelTokenChart models={byTokens} />
              </ChartFigure>
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>All models</CardTitle>
            <CardDescription>Share is of all spend · sort any column</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-1 sm:px-0">
          <ModelTable models={filtered} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Providers</CardTitle>
            <CardDescription>Summed from each project’s provider totals</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {providers.length === 0 ? (
            <EmptyState title="No provider history yet" />
          ) : (
            <BarList
              label="Providers by estimated cost"
              className="sm:grid-cols-2 sm:gap-x-8"
              items={providers.map((p) => ({
                key: p.provider,
                label: p.provider,
                value: p.cost,
                valueText: formatCurrency(p.cost),
                detail: `${formatPercent(p.percentageOfTotal / 100)} · ${formatCompact(p.totalTokens)} tokens · ${formatCostPerMillion(p.costPerMillion)} · ${plural(p.modelCount, "model")}`,
              }))}
            />
          )}
        </CardContent>
      </Card>
      <EstimateNote />
    </>
  );
}
