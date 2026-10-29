import { binFor, type Matrix } from "../lib/series.js";
import { cn } from "../lib/utils.js";

export const SEQ_STEPS = 8;

/**
 * The 2D form of a matrix: a real table whose cells are shaded on the
 * sequential ramp (linear in value, the same scale the 3D bar heights use).
 * It is both the no-WebGL fallback and the accessible reading of the 3D view —
 * every cell carries its exact value as text for assistive tech and on hover.
 */
export function HeatmapGrid({
  matrix,
  rowHeader,
  formatRow,
  formatCol,
  formatValue,
  colEvery = 1,
  caption,
}: {
  matrix: Matrix;
  rowHeader: string;
  formatRow: (row: string) => string;
  formatCol: (col: string) => string;
  formatValue: (value: number) => string;
  /** Show every Nth column header label to avoid collisions (all cells stay). */
  colEvery?: number;
  caption: string;
}) {
  return (
    // `relative` keeps the cells' sr-only spans (absolutely positioned) inside
    // this scroller; without it they escape and widen the whole page.
    <div className="relative max-h-[28rem] overflow-auto rounded-lg border">
      <table className="border-separate border-spacing-0.5 text-[11px]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky top-0 left-0 z-30 bg-card px-2 py-1 text-left font-medium text-muted-foreground"
            >
              {rowHeader}
            </th>
            {matrix.cols.map((col, index) => (
              <th
                key={col}
                scope="col"
                className={cn(
                  "sticky top-0 h-6 min-w-4 bg-card p-0 text-left font-normal text-muted-foreground",
                  // Labelled columns sit above their neighbours so the label isn't painted over.
                  index % colEvery === 0 ? "z-20" : "z-10"
                )}
              >
                {/* Absolutely placed so a label can run past its narrow column without widening it. */}
                <span
                  className={cn(
                    "absolute top-1 left-0 whitespace-nowrap",
                    index % colEvery !== 0 && "sr-only"
                  )}
                >
                  {formatCol(col)}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {matrix.rows.map((row, r) => (
            <tr key={row}>
              <th
                scope="row"
                className="sticky left-0 z-10 max-w-40 truncate bg-card px-2 text-left font-normal"
                title={formatRow(row)}
              >
                {formatRow(row)}
              </th>
              {matrix.values[r].map((value, c) => {
                const bin = binFor(value, matrix.max, SEQ_STEPS);
                const text = `${formatRow(row)}, ${formatCol(matrix.cols[c])}: ${value > 0 ? formatValue(value) : "none"}`;
                return (
                  <td
                    key={matrix.cols[c]}
                    title={text}
                    className="size-4 min-w-4 rounded-[3px]"
                    style={{ background: value > 0 ? `var(--seq-${bin})` : "var(--muted)" }}
                  >
                    <span className="sr-only">{text}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Legend for the sequential ramp, with the value range it spans. */
export function SequentialLegend({
  max,
  formatValue,
}: {
  max: number;
  formatValue: (v: number) => string;
}) {
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <span className="num">{formatValue(0)}</span>
      <span
        aria-hidden
        className="h-2 w-28 rounded-full"
        style={{
          background: `linear-gradient(to right, ${Array.from({ length: SEQ_STEPS - 1 }, (_, i) => `var(--seq-${i + 1})`).join(", ")})`,
        }}
      />
      <span className="num">{formatValue(max)}</span>
    </div>
  );
}
