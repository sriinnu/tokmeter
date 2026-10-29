import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "../lib/utils.js";

export interface BarListItem {
  key: string;
  label: string;
  href?: string;
  /** Drives bar length. */
  value: number;
  valueText: string;
  detail?: ReactNode;
  /** Identity colour when the list is the legend of another chart (the Today dial). */
  swatch?: string;
}

/**
 * Ranked horizontal bars as a plain list: every bar has its number beside it,
 * so it reads without a tooltip and works as-is for screen readers. One
 * series, one colour — the bar length is the only encoding.
 */
export function BarList({
  items,
  max,
  className,
  label,
}: {
  items: BarListItem[];
  max?: number;
  className?: string;
  label: string;
}) {
  const scale = max ?? Math.max(0, ...items.map((item) => item.value));
  return (
    <ol className={cn("grid gap-2.5", className)} aria-label={label}>
      {items.map((item) => {
        const pct = scale > 0 ? Math.max(0.5, (item.value / scale) * 100) : 0;
        return (
          <li key={item.key} className="grid gap-1">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="flex min-w-0 items-center gap-1.5">
                {item.swatch && (
                  <span
                    aria-hidden
                    className="size-2.5 shrink-0 rounded-[3px]"
                    style={{ background: item.swatch }}
                  />
                )}
                {item.href ? (
                  <Link
                    to={item.href}
                    className="min-w-0 truncate underline-offset-2 hover:underline"
                    title={item.label}
                  >
                    {item.label}
                  </Link>
                ) : (
                  <span className="min-w-0 truncate" title={item.label}>
                    {item.label}
                  </span>
                )}
              </span>
              <span className="num shrink-0 font-medium">{item.valueText}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
              <div
                className="h-full origin-left animate-bar-grow rounded-full bg-series-1 transition-[width] duration-500"
                style={{ width: `${pct}%`, background: item.swatch }}
              />
            </div>
            {item.detail && <div className="num text-xs text-muted-foreground">{item.detail}</div>}
          </li>
        );
      })}
    </ol>
  );
}
