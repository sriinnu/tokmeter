import type { ReactNode } from "react";
import { cn } from "../../lib/utils.js";

/**
 * Empty/error-state illustrations drawn from the brand's ledger-grid
 * vocabulary: a 3×3 grid of day cells, violet for sealed, amber for today.
 * Colours are theme tokens so both themes work; every illustration is
 * decorative (aria-hidden) — the text beside it carries the message.
 */
export type LedgerArtKind = "offline" | "error" | "not-found" | "empty" | "no-webgl";

const CELL = 18;
const GAP = 6;
const ORIGIN_X = 30;
const ORIGIN_Y = 14;

type CellStyle = "sealed" | "sealed-2" | "sealed-3" | "today" | "ghost" | "dim";

const FILL: Record<CellStyle, string> = {
  sealed: "var(--brand-1)",
  "sealed-2": "var(--brand-2)",
  "sealed-3": "var(--brand-3)",
  today: "var(--brand-amber)",
  ghost: "none",
  dim: "var(--muted)",
};

function Cell({
  i,
  style,
  dx = 0,
  dy = 0,
  rotate = 0,
}: {
  i: number;
  style: CellStyle;
  dx?: number;
  dy?: number;
  rotate?: number;
}) {
  const x = ORIGIN_X + (i % 3) * (CELL + GAP) + dx;
  const y = ORIGIN_Y + Math.floor(i / 3) * (CELL + GAP) + dy;
  return (
    <rect
      x={x}
      y={y}
      width={CELL}
      height={CELL}
      rx={4}
      fill={FILL[style]}
      stroke={style === "ghost" || style === "dim" ? "var(--border)" : "none"}
      strokeWidth={style === "ghost" ? 1.5 : 1}
      strokeDasharray={style === "ghost" ? "3 3" : undefined}
      transform={rotate ? `rotate(${rotate} ${x + CELL / 2} ${y + CELL / 2})` : undefined}
    />
  );
}

const SEALED: CellStyle[] = [
  "sealed",
  "sealed-2",
  "sealed-3",
  "sealed-2",
  "sealed-3",
  "sealed",
  "sealed-3",
  "sealed-2",
];

function Art({ kind }: { kind: LedgerArtKind }): ReactNode {
  switch (kind) {
    case "empty":
      // Nothing recorded yet: an empty ledger waiting on its first day.
      return (
        <>
          {Array.from({ length: 8 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed geometry
            <Cell key={i} i={i} style="ghost" />
          ))}
          <Cell i={8} style="today" />
        </>
      );
    case "offline":
      // The ledger is there but dimmed, and the link to it is unplugged.
      return (
        <>
          {Array.from({ length: 9 }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: fixed geometry
            <Cell key={i} i={i} style="dim" />
          ))}
          <path
            d="M8 48h10"
            stroke="var(--muted-foreground)"
            strokeWidth={3}
            strokeLinecap="round"
          />
          <rect x={16} y={42} width={6} height={12} rx={2} fill="var(--muted-foreground)" />
          <path
            d="M108 48h-6"
            stroke="var(--muted-foreground)"
            strokeWidth={3}
            strokeLinecap="round"
          />
          <rect x={100} y={42} width={6} height={12} rx={2} fill="var(--muted-foreground)" />
          <path
            d="M24 40l3-4M24 56l3 4"
            stroke="var(--brand-amber)"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </>
      );
    case "error":
      // One cell has slipped out of the grid.
      return (
        <>
          {SEALED.map((style, i) =>
            i === 4 ? (
              <Cell key={style + String(i)} i={i} style="ghost" />
            ) : (
              <Cell key={style + String(i)} i={i} style={style} />
            )
          )}
          <Cell i={8} style="today" />
          <Cell i={4} style="sealed-3" dx={34} dy={-6} rotate={24} />
          <path
            d="M60 46l4 4m0-4l-4 4"
            stroke="var(--critical)"
            strokeWidth={2}
            strokeLinecap="round"
          />
        </>
      );
    case "not-found":
      // A ledger with a missing slot, and a lens over it.
      return (
        <>
          {SEALED.map((style, i) => (
            <Cell key={style + String(i)} i={i} style={i === 4 ? "ghost" : style} />
          ))}
          <Cell i={8} style="today" />
          <circle
            cx={69}
            cy={47}
            r={15}
            fill="var(--card)"
            fillOpacity={0.55}
            stroke="var(--foreground)"
            strokeWidth={2.5}
          />
          <path d="M80 58l12 12" stroke="var(--foreground)" strokeWidth={4} strokeLinecap="round" />
        </>
      );
    case "no-webgl":
      // The same grid, flat: the 3D field falls back to 2D.
      return (
        <>
          {SEALED.map((style, i) => (
            <Cell key={style + String(i)} i={i} style={style} />
          ))}
          <Cell i={8} style="today" />
          <path
            d="M30 14l-14 -8M102 14l-14 -8M30 86l-14 -8M16 6v72M16 6h72"
            fill="none"
            stroke="var(--border)"
            strokeWidth={1.5}
            strokeDasharray="3 3"
          />
        </>
      );
  }
}

export function LedgerArt({ kind, className }: { kind: LedgerArtKind; className?: string }) {
  return (
    <svg
      viewBox="0 0 132 96"
      aria-hidden="true"
      className={cn("h-20 w-auto shrink-0 animate-fade-in", className)}
    >
      <Art kind={kind} />
    </svg>
  );
}
