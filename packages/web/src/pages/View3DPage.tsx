import { Info } from "lucide-react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { HeatmapGrid, SequentialLegend } from "../charts/HeatmapGrid.js";
import { DataGate } from "../components/DataGate.js";
import { PageHeader } from "../components/PageHeader.js";
import { EmptyState } from "../components/states.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card.js";
import { Skeleton } from "../components/ui/skeleton.js";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../components/ui/tooltip.js";
import { useStoredState } from "../hooks/useStoredState.js";
import type { TokmeterData } from "../hooks/useTokmeterData.js";
import { useWebGLSupport } from "../hooks/useWebGLSupport.js";
import { dateRange, localDateKey } from "../lib/dates.js";
import {
  formatCurrency,
  formatHour,
  formatInteger,
  formatPercent,
  formatShortDate,
} from "../lib/format.js";
import { useMotion } from "../lib/motion.js";
import {
  buildDayHourMatrix,
  buildDayProjectMatrix,
  type Metric,
  recordsWindowStart,
  spanDays,
} from "../lib/series.js";
import { useTheme } from "../lib/theme.js";

// three.js (~0.5 MB) only loads once this route has confirmed WebGL.
const BarField3D = lazy(() => import("../three/BarField3D.js"));

type Dimension = "project" | "hour";
const WINDOWS = ["30", "60", "90", "all"] as const;
type Window = (typeof WINDOWS)[number];
const isWindow = (value: string): value is Window => (WINDOWS as readonly string[]).includes(value);
const TOP_PROJECTS = 10;
const MAX_HOUR_DAYS = 14;

export function View3DPage() {
  return <DataGate>{(data) => <View3D data={data} />}</DataGate>;
}

function View3D({ data }: { data: TokmeterData }) {
  const [dimension, setDimension] = useState<Dimension>("project");
  const [metric, setMetric] = useState<Metric>("cost");
  const [range, setRange] = useStoredState<Window>("tokmeter.range.3d", "30", isWindow);
  const windowDays =
    range === "all" ? spanDays(data.daily, localDateKey(Date.now()), 3660) : Number(range);
  const webgl = useWebGLSupport();
  const reducedMotion = !useMotion().enabled;
  const { resolved } = useTheme();
  const todayKey = localDateKey(Date.now());

  const recordsStart = useMemo(
    () => recordsWindowStart(data.records, localDateKey),
    [data.records]
  );
  const matrix = useMemo(() => {
    if (dimension === "project") {
      return buildDayProjectMatrix(
        data.projects,
        dateRange(todayKey, windowDays),
        metric,
        TOP_PROJECTS
      );
    }
    if (!recordsStart) return null;
    const span = Math.round(
      (new Date(`${todayKey}T00:00:00`).getTime() -
        new Date(`${recordsStart}T00:00:00`).getTime()) /
        86_400_000
    );
    const days = dateRange(todayKey, Math.min(MAX_HOUR_DAYS, Math.max(1, span + 1)));
    return buildDayHourMatrix(data.records, days, metric, localDateKey);
  }, [data.projects, data.records, dimension, metric, windowDays, todayKey, recordsStart]);

  const formatValue = useCallback(
    (value: number) => (metric === "cost" ? formatCurrency(value) : formatInteger(value)),
    [metric]
  );
  const rowLabel = useCallback(
    (row: string) => (dimension === "project" ? row : formatShortDate(row)),
    [dimension]
  );
  const colLabel = useCallback(
    (col: string) => (dimension === "project" ? formatShortDate(col) : formatHour(Number(col))),
    [dimension]
  );

  const hasData = matrix !== null && matrix.rows.length > 0 && matrix.max > 0;
  const colEvery = matrix
    ? Math.max(1, Math.ceil(matrix.cols.length / (dimension === "hour" ? 8 : 10)))
    : 1;
  const measure = metric === "cost" ? "estimated cost" : "tokens";
  const title =
    dimension === "project" ? `Day × project, ${measure}` : `Day × hour of day, ${measure}`;
  const summary = matrix
    ? `${title}: ${matrix.rows.length} rows by ${matrix.cols.length} columns, largest cell ${formatValue(matrix.max)}, ${formatValue(matrix.shownTotal)} in total. The data grid below lists every cell.`
    : title;

  return (
    <>
      <PageHeader
        title="3D view"
        description="Bar height and colour are both linear in the selected measure."
      />
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          value={dimension}
          onValueChange={(value) => value && setDimension(value as Dimension)}
          aria-label="Grid"
        >
          <ToggleGroupItem value="project">Day × project</ToggleGroupItem>
          <ToggleGroupItem value="hour">Day × hour</ToggleGroupItem>
        </ToggleGroup>
        <ToggleGroup
          type="single"
          value={metric}
          onValueChange={(value) => value && setMetric(value as Metric)}
          aria-label="Measure"
        >
          <ToggleGroupItem value="cost">Cost</ToggleGroupItem>
          <ToggleGroupItem value="tokens">Tokens</ToggleGroupItem>
        </ToggleGroup>
        {dimension === "project" && (
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
        )}
        {dimension === "hour" && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-muted px-2.5 text-xs text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Info className="size-3.5" aria-hidden />
                Last {MAX_HOUR_DAYS} days only
              </button>
            </TooltipTrigger>
            <TooltipContent>
              Hour-of-day detail only exists in the summary’s raw records window (about{" "}
              {MAX_HOUR_DAYS} days). Sealed history keeps daily totals, not hours, so there is no
              all-time hourly view.
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>{title}</CardTitle>
            <CardDescription>
              <ScopeNote dimension={dimension} matrix={matrix} />
            </CardDescription>
          </div>
          {hasData && <SequentialLegend max={matrix.max} formatValue={formatValue} />}
        </CardHeader>
        <CardContent>
          {!hasData ? (
            <EmptyState
              title="Nothing to plot"
              message={
                dimension === "hour"
                  ? "This summary has no raw records in its recent window, so there is no hourly data."
                  : range === "all"
                    ? "No project usage yet."
                    : `No project usage in the last ${windowDays} days.`
              }
            />
          ) : webgl === "unsupported" ? (
            <EmptyState
              art="no-webgl"
              title="3D needs WebGL"
              message="WebGL isn’t available in this browser, so the 3D field is off. The grid below shows the same values."
            />
          ) : webgl === "checking" ? (
            <Skeleton className="h-[min(62vh,520px)] min-h-72 w-full rounded-lg" />
          ) : (
            <Suspense
              fallback={<Skeleton className="h-[min(62vh,520px)] min-h-72 w-full rounded-lg" />}
            >
              <BarField3D
                matrix={matrix}
                label={summary}
                rowLabel={rowLabel}
                colLabel={colLabel}
                formatValue={formatValue}
                theme={resolved}
                reducedMotion={reducedMotion}
                colEvery={colEvery}
              />
            </Suspense>
          )}
        </CardContent>
      </Card>

      {hasData && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Data grid</CardTitle>
              <CardDescription>
                The same cells in 2D · hover or use a screen reader for exact values
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <HeatmapGrid
              matrix={matrix}
              rowHeader={dimension === "project" ? "Project" : "Day"}
              formatRow={rowLabel}
              formatCol={colLabel}
              formatValue={formatValue}
              colEvery={colEvery}
              caption={summary}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

function ScopeNote({
  dimension,
  matrix,
}: {
  dimension: Dimension;
  matrix: ReturnType<typeof buildDayProjectMatrix> | null;
}) {
  if (dimension === "hour") {
    return (
      <>
        From the summary’s raw records window (up to {MAX_HOUR_DAYS} days), bucketed by local hour.
        Per-day sums here come from raw records and can differ slightly from the sealed ledger.
      </>
    );
  }
  if (!matrix) return null;
  const covered = matrix.sourceTotal > 0 ? matrix.shownTotal / matrix.sourceTotal : 1;
  return (
    <>
      From each project’s daily ledger.{" "}
      {matrix.omittedRows > 0
        ? `Top ${matrix.rows.length} projects shown (${formatPercent(covered)} of the window); ${matrix.omittedRows} smaller ${matrix.omittedRows === 1 ? "project is" : "projects are"} left out.`
        : `All ${matrix.rows.length} active projects shown.`}
    </>
  );
}
