import { Search } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { DataGate } from "../components/DataGate.js";
import { EstimateNote } from "../components/EstimateNote.js";
import { PageHeader } from "../components/PageHeader.js";
import { SortableHead } from "../components/SortableHead.js";
import { Sparkline } from "../components/Sparkline.js";
import { EmptyState } from "../components/states.js";
import { Card, CardContent } from "../components/ui/card.js";
import { Input } from "../components/ui/input.js";
import { NativeSelect } from "../components/ui/native-select.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table.js";
import { useSort } from "../hooks/useSort.js";
import type { TokmeterData, TokmeterProjectSummary } from "../hooks/useTokmeterData.js";
import { dateRange, localDateKey } from "../lib/dates.js";
import {
  formatCompact,
  formatCurrency,
  formatInteger,
  formatPercent,
  formatTimestamp,
  plural,
} from "../lib/format.js";
import { projectHref } from "./projects/project-href.js";

const ALL = "__all__";
type Column = "project" | "cost" | "tokens" | "days" | "models" | "lastUsed";
const ACCESSORS: Record<Column, (p: TokmeterProjectSummary) => number | string> = {
  project: (p) => p.project.toLowerCase(),
  cost: (p) => p.totalCost,
  tokens: (p) => p.totalTokens,
  days: (p) => p.activeDays,
  models: (p) => p.models.length,
  lastUsed: (p) => p.lastUsed,
};

export function ProjectsPage() {
  return <DataGate>{(data) => <ProjectsView data={data} />}</DataGate>;
}

function ProjectsView({ data }: { data: TokmeterData }) {
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState(ALL);
  const providers = useMemo(
    () => [...new Set(data.projects.flatMap((p) => p.providers.map((x) => x.provider)))].sort(),
    [data.projects]
  );
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return data.projects.filter(
      (p) =>
        (!needle || p.project.toLowerCase().includes(needle)) &&
        (provider === ALL || p.providers.some((x) => x.provider === provider))
    );
  }, [data.projects, query, provider]);
  const { sorted, sort, toggle } = useSort(filtered, ACCESSORS, { key: "cost", direction: "desc" });
  const totalCost = data.stats.totalCost;
  const last30 = useMemo(() => dateRange(localDateKey(Date.now()), 30), []);

  return (
    <>
      <PageHeader
        title="Projects"
        description={`${plural(data.projects.length, "project")} · costs are all-time estimates`}
      />
      <Card>
        <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3 sm:px-5">
          <div className="relative min-w-0 flex-1 basis-56">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Filter projects"
              aria-label="Filter projects by name"
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
            {providers.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </NativeSelect>
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {filtered.length === data.projects.length
              ? `${formatInteger(filtered.length)} shown`
              : `${formatInteger(filtered.length)} of ${formatInteger(data.projects.length)}`}
          </span>
        </div>
        <CardContent className="px-0 pt-0 pb-0 sm:px-0">
          {sorted.length === 0 ? (
            <div className="p-4">
              <EmptyState
                title={data.projects.length === 0 ? "No projects yet" : "No projects match"}
                message={
                  data.projects.length === 0 ? undefined : "Try a different name or provider."
                }
              />
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead column="project" sort={sort} onSort={toggle}>
                    Project
                  </SortableHead>
                  <SortableHead column="cost" sort={sort} onSort={toggle} align="right">
                    Est. cost
                  </SortableHead>
                  <TableHead className="hidden text-right lg:table-cell">Share</TableHead>
                  <SortableHead column="tokens" sort={sort} onSort={toggle} align="right">
                    Tokens
                  </SortableHead>
                  <SortableHead
                    column="days"
                    sort={sort}
                    onSort={toggle}
                    align="right"
                    className="hidden sm:table-cell"
                  >
                    Days
                  </SortableHead>
                  <SortableHead
                    column="models"
                    sort={sort}
                    onSort={toggle}
                    align="right"
                    className="hidden md:table-cell"
                  >
                    Models
                  </SortableHead>
                  <SortableHead
                    column="lastUsed"
                    sort={sort}
                    onSort={toggle}
                    className="hidden md:table-cell"
                  >
                    Last used
                  </SortableHead>
                  <TableHead className="hidden lg:table-cell">Last 30 days</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sorted.map((p) => {
                  const byDate = new Map(p.dailyBreakdown.map((d) => [d.date, d.cost]));
                  return (
                    <TableRow key={p.project}>
                      <TableCell className="max-w-44 truncate sm:max-w-80">
                        <Link
                          to={projectHref(p.project)}
                          className="font-medium underline-offset-2 hover:underline"
                          title={p.project}
                        >
                          {p.project}
                        </Link>
                        <div className="truncate text-xs text-muted-foreground">
                          {p.providers.map((x) => x.provider).join(", ") || "—"}
                        </div>
                      </TableCell>
                      <TableCell className="num text-right font-medium">
                        {formatCurrency(p.totalCost)}
                      </TableCell>
                      <TableCell className="num hidden text-right text-muted-foreground lg:table-cell">
                        {totalCost > 0 ? formatPercent(p.totalCost / totalCost) : "—"}
                      </TableCell>
                      <TableCell className="num text-right" title={formatInteger(p.totalTokens)}>
                        {formatCompact(p.totalTokens)}
                      </TableCell>
                      <TableCell className="num hidden text-right sm:table-cell">
                        {p.activeDays}
                      </TableCell>
                      <TableCell className="num hidden text-right md:table-cell">
                        {p.models.length}
                      </TableCell>
                      <TableCell className="hidden text-muted-foreground md:table-cell">
                        {formatTimestamp(p.lastUsed)}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell">
                        <Sparkline
                          values={last30.map((d) => byDate.get(d) ?? 0)}
                          width={96}
                          height={22}
                        />
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
      <EstimateNote />
    </>
  );
}
