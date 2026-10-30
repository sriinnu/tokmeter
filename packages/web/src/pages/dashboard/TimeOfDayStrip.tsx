import { useMemo } from "react";
import { ChartFigure } from "../../components/ChartFigure.js";
import type { TokmeterTimeOfDay } from "../../hooks/useTokmeterData.js";
import { formatCurrency, plural } from "../../lib/format.js";
import {
  buildTimeOfDayView,
  formatBlock,
  formatShare,
  formatSharePrecise,
} from "../../lib/time-of-day.js";
import { cn } from "../../lib/utils.js";

/**
 * When the spend usually happens: share of the last 30 sealed days' COST in
 * each 3-hour local block. Cost, not tokens: the sealed ledger keeps an hourly
 * curve for cost only. One series, one colour; the busiest block's label is
 * set in bold so colour is never the only cue.
 */
export function TimeOfDayStrip({ profile }: { profile: TokmeterTimeOfDay | undefined }) {
  const view = useMemo(() => buildTimeOfDayView(profile), [profile]);

  return (
    <section
      className="mt-2 grid content-start gap-2 border-t pt-4"
      aria-label="Busiest hours, last 30 days"
    >
      <h3 className="text-xs font-medium text-muted-foreground">Busiest hours · last 30 days</h3>
      {view.state === "missing" ? (
        <p className="text-sm text-muted-foreground">
          Not in this summary. A current usage daemon provides it.
        </p>
      ) : view.state === "insufficient" ? (
        <p className="text-sm text-muted-foreground">
          Needs {view.minDays} days with an hourly cost curve; {view.daysCounted} so far.
        </p>
      ) : (
        <ChartFigure
          label="Share of cost by time of day"
          summary={`Busiest ${formatBlock(view.peak)}, ${formatShare(view.peak.share)} of cost over ${plural(view.daysCounted, "day")}.`}
          table={{
            columns: [
              { label: "Hours" },
              { label: "Share of cost", align: "right" },
              { label: "Est. cost", align: "right" },
            ],
            rows: view.blocks.map((b) => ({
              key: String(b.startHour),
              cells: [formatBlock(b), formatSharePrecise(b.share), formatCurrency(b.cost)],
            })),
          }}
        >
          <ol className="grid grid-cols-8 items-end gap-1.5" aria-hidden>
            {view.blocks.map((b) => {
              const isPeak = b === view.peak;
              const pct = view.maxShare > 0 ? (b.share / view.maxShare) * 100 : 0;
              return (
                <li key={b.startHour} className="grid gap-1 text-center">
                  <span
                    className={cn(
                      "num text-[11px]",
                      isPeak ? "font-semibold text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {formatShare(b.share)}
                  </span>
                  <div className="flex h-16 items-end overflow-hidden rounded-sm bg-muted">
                    <div
                      className="w-full rounded-sm bg-series-1 transition-[height] duration-500"
                      style={{ height: `${b.share > 0 ? Math.max(2, pct) : 0}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "num text-[10px]",
                      isPeak ? "font-semibold text-foreground" : "text-muted-foreground"
                    )}
                  >
                    {String(b.startHour).padStart(2, "0")}
                  </span>
                </li>
              );
            })}
          </ol>
        </ChartFigure>
      )}
      {view.state === "ok" && (
        <p className="num text-xs text-muted-foreground">
          Busiest {formatBlock(view.peak)} · share of est. cost, not tokens ·{" "}
          {plural(view.daysCounted, "day")}
          {view.daysSkipped > 0 &&
            ` (${plural(view.daysSkipped, "day")} without an hourly curve skipped)`}
        </p>
      )}
    </section>
  );
}
