import { ArrowDownRight, ArrowUpRight, Info, Minus } from "lucide-react";
import type { ReactNode } from "react";
import { formatSignedPercent, relativeChange } from "../lib/format.js";
import { cn } from "../lib/utils.js";
import { AnimatedNumber } from "./AnimatedNumber.js";
import { Sparkline } from "./Sparkline.js";
import { Card } from "./ui/card.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip.js";

/**
 * Headline number tile. The value is the chart; the sparkline and delta are
 * context. Deltas are only shown against a like-for-like span and are worded
 * neutrally — more spend is not "bad" by itself, so no red/green judgement.
 */
export function KpiTile({
  label,
  hint,
  badge,
  value,
  valueLabel,
  secondary,
  compare,
  footnote,
  series,
}: {
  label: string;
  /** How the number is derived; shown in a tooltip next to the label. */
  hint?: string;
  badge?: ReactNode;
  /**
   * The headline. Pass `{ value, format }` to count up to it; the settled text
   * is `format(value)` exactly.
   */
  value: string | { value: number; format: (value: number) => string };
  /** Spoken form when `value` is abbreviated. */
  valueLabel?: string;
  secondary?: ReactNode;
  compare?: { current: number; previous: number; label: string; previousText: string };
  footnote?: ReactNode;
  series?: number[];
}) {
  const change = compare ? relativeChange(compare.current, compare.previous) : null;
  const ChangeIcon =
    change === null || change === 0 ? Minus : change > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Card className="flex flex-col gap-3 p-4 transition-[translate,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h2 className="text-xs font-medium text-muted-foreground">{label}</h2>
          {hint && (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`How “${label}” is calculated`}
                  className="rounded-sm text-muted-foreground hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Info className="size-3.5" aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>{hint}</TooltipContent>
            </Tooltip>
          )}
        </div>
        {badge}
      </div>
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="num truncate text-2xl font-semibold tracking-tight sm:text-[1.75rem]">
            {typeof value === "object" ? (
              <AnimatedNumber value={value.value} format={value.format} label={valueLabel} />
            ) : valueLabel ? (
              <>
                <span aria-hidden>{value}</span>
                <span className="sr-only">{valueLabel}</span>
              </>
            ) : (
              value
            )}
          </div>
          {secondary && (
            <div className="num mt-0.5 truncate text-xs text-muted-foreground">{secondary}</div>
          )}
        </div>
        {series && series.length > 1 && <Sparkline values={series} className="shrink-0" />}
      </div>
      {(compare || footnote) && (
        <div className="mt-auto flex flex-wrap items-center gap-x-2 gap-y-1 border-t pt-2.5 text-xs text-muted-foreground">
          {compare && (
            <span className="inline-flex items-center gap-1">
              <ChangeIcon className={cn("size-3.5", change === null && "opacity-50")} aria-hidden />
              <span className="num font-medium text-foreground">
                {change === null ? "—" : formatSignedPercent(change)}
              </span>
              <span>
                {compare.label} ({compare.previousText})
              </span>
            </span>
          )}
          {footnote && <span>{footnote}</span>}
        </div>
      )}
    </Card>
  );
}
