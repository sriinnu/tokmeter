import { ArrowLeft } from "lucide-react";
import { useMemo } from "react";
import { Link, useParams } from "react-router-dom";
import { projectNameIncludes, projectNamesMatch } from "../../../../core/src/project-name.js";
import { BarList } from "../../charts/BarList.js";
import { DataGate } from "../../components/DataGate.js";
import { EstimateNote } from "../../components/EstimateNote.js";
import { KpiTile } from "../../components/KpiTile.js";
import { PageHeader } from "../../components/PageHeader.js";
import { EmptyState } from "../../components/states.js";
import { TokenComposition } from "../../components/TokenComposition.js";
import { Button } from "../../components/ui/button.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import type { TokmeterData, TokmeterProjectSummary } from "../../hooks/useTokmeterData.js";
import { localDateKey } from "../../lib/dates.js";
import {
  formatCompact,
  formatCostPerMillion,
  formatCurrency,
  formatInteger,
  formatPercent,
  formatTimestamp,
} from "../../lib/format.js";
import { DailySpendCard } from "../dashboard/DailySpendCard.js";
import { ModelTable } from "../models/ModelTable.js";

export function ProjectDetailPage() {
  const { name } = useParams<{ name: string }>();
  return <DataGate>{(data) => <ProjectDetail data={data} requested={name ?? ""} />}</DataGate>;
}

function findProject(data: TokmeterData, requested: string): TokmeterProjectSummary | undefined {
  // Exact (normalised) match first; the substring fallback keeps older links
  // from the bar working when a project path was shortened.
  return (
    data.projects.find((p) => projectNamesMatch(p.project, requested)) ??
    data.projects.find((p) => projectNameIncludes(p.project, requested))
  );
}

function ProjectDetail({ data, requested }: { data: TokmeterData; requested: string }) {
  const project = useMemo(() => findProject(data, requested), [data, requested]);
  const todayKey = localDateKey(Date.now());

  if (!project) {
    return (
      <>
        <BackLink />
        <PageHeader title="Project not found" />
        <EmptyState
          art="not-found"
          title="Nothing to show"
          message={`No project in this summary matches “${requested}”.`}
        />
      </>
    );
  }

  const share = data.stats.totalCost > 0 ? project.totalCost / data.stats.totalCost : 0;
  const costPerMillion =
    project.totalTokens > 0 ? (project.totalCost / project.totalTokens) * 1_000_000 : null;

  return (
    <>
      <BackLink />
      <PageHeader
        title={<span title={project.project}>{project.project}</span>}
        description={`Active ${formatTimestamp(project.firstUsed)} – ${formatTimestamp(project.lastUsed)}`}
      />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Est. cost, all time"
          value={{ value: project.totalCost, format: formatCurrency }}
          secondary={`${formatPercent(share)} of all spend`}
        />
        <KpiTile
          label="Tokens"
          value={{ value: project.totalTokens, format: formatCompact }}
          valueLabel={`${formatInteger(project.totalTokens)} tokens`}
          secondary={formatInteger(project.totalTokens)}
        />
        <KpiTile
          label="Active days"
          value={{ value: project.activeDays, format: formatInteger }}
          secondary={`${project.models.length} models · ${project.providers.length} providers`}
        />
        <KpiTile
          label="Est. cost / 1M tokens"
          value={formatCostPerMillion(costPerMillion)}
          secondary="Blended across models"
        />
      </div>

      <DailySpendCard
        title="Daily usage for this project"
        storageKey="tokmeter.range.project"
        daily={project.dailyBreakdown}
        meta={data.meta}
        todayKey={todayKey}
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Token composition</CardTitle>
              <CardDescription>All time, by bucket</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <TokenComposition totals={project} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Providers</CardTitle>
              <CardDescription>Est. cost in this project</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <BarList
              label="Providers in this project by estimated cost"
              items={[...project.providers]
                .sort((a, b) => b.cost - a.cost)
                .map((p) => ({
                  key: p.provider,
                  label: p.provider,
                  value: p.cost,
                  valueText: formatCurrency(p.cost),
                  detail: `${formatCompact(p.totalTokens)} tokens · ${p.models.length} models`,
                }))}
            />
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Models in this project</CardTitle>
            <CardDescription>Share is of this project’s estimated cost</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-0 pb-1 sm:px-0">
          <ModelTable models={project.models} shareBase={project.totalCost} />
        </CardContent>
      </Card>
      <EstimateNote />
    </>
  );
}

function BackLink() {
  return (
    <Button asChild variant="ghost" size="sm" className="-ml-2 justify-self-start">
      <Link to="/projects">
        <ArrowLeft aria-hidden /> Projects
      </Link>
    </Button>
  );
}
