import { cn } from "../../lib/utils.js";

// The sealed-ledger mark at its small size (site/public/icon.svg): eight
// sealed days in violet, today in amber. Geometry is fixed; only motion and
// the today cell's state vary.
export const LEDGER_CELLS = [
  [7, 7, "#5B45C9"],
  [25, 7, "#8B7CFF"],
  [43, 7, "#B4A8FF"],
  [7, 25, "#8B7CFF"],
  [25, 25, "#B4A8FF"],
  [43, 25, "#5B45C9"],
  [7, 43, "#B4A8FF"],
  [25, 43, "#8B7CFF"],
  [43, 43, "#F5B841"],
] as const;

const FILL_STAGGER_MS = 55;

/**
 * On mount the eight sealed cells fill in reading order (last one lands by
 * ~630 ms). The amber "today" cell breathes while the daemon stream is live
 * and turns grey and still when it isn't — the mark doubles as a status light,
 * but the LiveIndicator text next to it is what carries the state.
 */
export function BrandMark({ live, className }: { live: boolean; className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn("size-7 shrink-0", className)} aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="#171B25" />
      {LEDGER_CELLS.map(([x, y, fill], index) => {
        const today = index === LEDGER_CELLS.length - 1;
        return (
          <rect
            key={`${x}-${y}`}
            x={x}
            y={y}
            width="14"
            height="14"
            rx="3"
            fill={today && !live ? "#5E6472" : fill}
            className={cn(
              "origin-center [transform-box:fill-box]",
              today ? live && "animate-ledger-breathe" : "animate-ledger-fill"
            )}
            style={today ? undefined : { animationDelay: `${index * FILL_STAGGER_MS}ms` }}
          />
        );
      })}
    </svg>
  );
}
