import type { TokmeterDailyEntry } from "../hooks/useTokmeterData.js";
import { addDays, parseDateKey, startOfWeek } from "../lib/dates.js";
import { formatCurrency, formatInteger, formatLongDate } from "../lib/format.js";
import type { Metric } from "../lib/series.js";

const CELL = 11;
const GAP = 2;
const LEFT = 26;
const TOP = 14;
const LEVEL_FILL = ["var(--muted)", "var(--seq-2)", "var(--seq-4)", "var(--seq-5)", "var(--seq-7)"];

/**
 * Calendar heatmap of the last year, one cell per day. Levels are quartiles of
 * active days rather than fractions of the max, so a single huge day doesn't
 * wash every other day out to "nothing". Exact values are in each cell's
 * tooltip and in the daily table.
 */
export function ContributionHeatmap({
  daily,
  todayKey,
  metric = "cost",
  weeks = 53,
}: {
  daily: TokmeterDailyEntry[];
  todayKey: string;
  metric?: Metric;
  weeks?: number;
}) {
  const pick = (entry: TokmeterDailyEntry) => (metric === "cost" ? entry.cost : entry.totalTokens);
  const byDate = new Map(daily.map((entry) => [entry.date, entry]));
  const start = addDays(startOfWeek(todayKey), -(weeks - 1) * 7);
  const thresholds = quartiles(
    daily
      .filter((entry) => entry.date >= start && entry.date <= todayKey)
      .map(pick)
      .filter((v) => v > 0)
  );

  const cells: Array<{ date: string; x: number; y: number; level: number; value: number }> = [];
  const months: Array<{ x: number; label: string }> = [];
  for (let w = 0; w < weeks; w++) {
    for (let d = 0; d < 7; d++) {
      const date = addDays(start, w * 7 + d);
      if (date > todayKey) continue;
      const entry = byDate.get(date);
      const value = entry ? pick(entry) : 0;
      cells.push({
        date,
        x: LEFT + w * (CELL + GAP),
        y: TOP + d * (CELL + GAP),
        value,
        level: level(value, thresholds),
      });
    }
    // Label a column when its Monday starts a new month.
    const monday = addDays(start, w * 7);
    if (w > 0 && monday.slice(0, 7) !== addDays(monday, -7).slice(0, 7)) {
      months.push({
        x: LEFT + w * (CELL + GAP),
        label: new Intl.DateTimeFormat(undefined, { month: "short" }).format(parseDateKey(monday)),
      });
    }
  }
  const width = LEFT + weeks * (CELL + GAP);
  const height = TOP + 7 * (CELL + GAP);
  const format = (value: number) =>
    metric === "cost" ? formatCurrency(value) : formatInteger(value);

  return (
    <div className="grid gap-2">
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="h-auto w-full min-w-[540px]"
          role="img"
          aria-label={`Daily ${metric === "cost" ? "estimated cost" : "tokens"} over the last ${weeks} weeks. Exact values are in the daily table.`}
        >
          {months.map((month) => (
            <text key={`${month.x}`} x={month.x} y={9} className="fill-(--chart-axis) text-[9px]">
              {month.label}
            </text>
          ))}
          {[
            ["Mon", 0],
            ["Wed", 2],
            ["Fri", 4],
          ].map(([label, row]) => (
            <text
              key={label as string}
              x={0}
              y={TOP + (row as number) * (CELL + GAP) + CELL - 2}
              className="fill-(--chart-axis) text-[9px]"
            >
              {label}
            </text>
          ))}
          {cells.map((cell) => (
            <rect
              key={cell.date}
              x={cell.x}
              y={cell.y}
              width={CELL}
              height={CELL}
              rx={2}
              fill={LEVEL_FILL[cell.level]}
              stroke={cell.date === todayKey ? "var(--foreground)" : "none"}
              strokeWidth={cell.date === todayKey ? 1 : 0}
            >
              <title>
                {`${formatLongDate(cell.date)}: ${cell.value > 0 ? format(cell.value) : "no usage"}${cell.date === todayKey ? " (today, live)" : ""}`}
              </title>
            </rect>
          ))}
        </svg>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-1.5 text-xs text-muted-foreground">
        <span>Less</span>
        {LEVEL_FILL.map((fill) => (
          <span
            key={fill}
            aria-hidden
            className="size-2.5 rounded-[2px]"
            style={{ background: fill }}
          />
        ))}
        <span>More</span>
        <span className="ml-2">(quartiles of active days)</span>
      </div>
    </div>
  );
}

function quartiles(values: number[]): [number, number, number] {
  if (values.length === 0) return [0, 0, 0];
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return [at(0.25), at(0.5), at(0.75)];
}

function level(value: number, [q1, q2, q3]: [number, number, number]): number {
  if (value <= 0) return 0;
  if (value <= q1) return 1;
  if (value <= q2) return 2;
  if (value <= q3) return 3;
  return 4;
}
