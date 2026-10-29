import { type KeyboardEvent, useRef, useState } from "react";
import { AnimatedNumber } from "../components/AnimatedNumber.js";
import { useNow } from "../hooks/useNow.js";
import { formatCompact, formatCurrency, formatHour, formatInteger } from "../lib/format.js";
import { useMotion } from "../lib/motion.js";
import { type TodayDial as Dial, OTHER_KEY, type TypicalDay } from "../lib/today-dial.js";
import { cn } from "../lib/utils.js";

const C = 160;
const R0 = 58;
const R1 = 138;
// Distinct hues from the validated categorical palette, not a lightness ramp:
// a stacked wedge has to say which model is which. Series 4 (amber) is skipped
// because amber marks the current hour.
const SERIES_COLORS = ["var(--series-1)", "var(--series-3)", "var(--series-5)", "var(--series-2)"];

export function seriesColor(dial: Dial, key: string): string {
  if (key === OTHER_KEY) return "var(--dial-other)";
  const index = dial.series.findIndex((s) => s.key === key);
  return index >= 0 && index < SERIES_COLORS.length ? SERIES_COLORS[index] : "var(--dial-other)";
}

/** Point on the dial: degrees clockwise from 12 o'clock. */
function polar(radius: number, degrees: number): [number, number] {
  const a = ((degrees - 90) * Math.PI) / 180;
  return [C + radius * Math.cos(a), C + radius * Math.sin(a)];
}

function sector(r1: number, r2: number, a1: number, a2: number): string {
  const [x1, y1] = polar(r2, a1);
  const [x2, y2] = polar(r2, a2);
  const [x3, y3] = polar(r1, a2);
  const [x4, y4] = polar(r1, a1);
  return `M${x1},${y1} A${r2},${r2} 0 0 1 ${x2},${y2} L${x3},${y3} A${r1},${r1} 0 0 0 ${x4},${y4} Z`;
}

const hourAngles = (h: number): [number, number] => [h * 15 + 0.9, (h + 1) * 15 - 0.9];

/**
 * Today as a 24-hour clock, midnight at the top. Each hour is a radial bar
 * whose LENGTH (not area) is linear in that hour's cost, stacked by model.
 * The faint staircase ring is a typical day for comparison. Every hour is a
 * focusable control (roving tabindex, arrow keys) whose exact numbers show in
 * the readout beside the dial.
 */
export function TodayDial({
  dial,
  typical,
  ledgerCost,
}: {
  dial: Dial;
  typical: TypicalDay | null;
  /** Today's ledger cost, to flag if the hourly records disagree with it. */
  ledgerCost: number;
}) {
  const { enabled: motion } = useMotion();
  const now = new Date(useNow(30_000));
  const nowHour = now.getHours();
  const [selected, setSelected] = useState(nowHour);
  const hitRefs = useRef<Array<SVGPathElement | null>>([]);
  const measure = dial.measure;
  const fmt = (v: number) => (measure === "cost" ? formatCurrency(v) : formatCompact(v));
  const scale = Math.max(dial.max, ...(typical?.values ?? [0])) || 1;
  const radius = (v: number) => R0 + (v / scale) * (R1 - R0);
  const handDeg = (now.getHours() + now.getMinutes() / 60) * 15;
  const hour = dial.hours[selected];

  const move = (event: KeyboardEvent, h: number) => {
    const delta: Record<string, number> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
    };
    let next: number | null = null;
    if (event.key in delta) next = (h + delta[event.key] + 24) % 24;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = 23;
    if (next === null) return;
    event.preventDefault();
    setSelected(next);
    hitRefs.current[next]?.focus();
  };

  return (
    <div className="grid items-start gap-5 sm:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
      <div className="relative mx-auto aspect-square w-full max-w-[320px]">
        <svg
          viewBox="-12 -12 344 344"
          className="size-full overflow-visible"
          aria-label="Today by hour: each hour is a button with its exact figures"
        >
          <title>Today by hour</title>
          {dial.hours.map((h) => {
            const [a1, a2] = hourAngles(h.hour);
            const future = h.hour > nowHour;
            let inner = R0;
            return (
              <g key={h.hour} aria-hidden>
                <path
                  d={sector(R0, R1, a1, a2)}
                  fill={future ? "none" : "var(--muted)"}
                  fillOpacity={future ? 0 : 0.55}
                  stroke={future ? "var(--border)" : "none"}
                  strokeDasharray={future ? "2 3" : undefined}
                />
                {h.segments.map((segment) => {
                  if (segment.value <= 0) return null;
                  const outer = inner + (segment.value / scale) * (R1 - R0);
                  const d = sector(inner, outer, a1, a2);
                  inner = outer;
                  return (
                    <path
                      key={segment.key}
                      d={d}
                      fill={seriesColor(dial, segment.key)}
                      stroke="var(--card)"
                      strokeWidth={0.75}
                    />
                  );
                })}
                {h.hour === nowHour && (
                  <path
                    d={sector(R0, Math.max(radius(h.value), R0 + 3), a1, a2)}
                    fill="none"
                    stroke="var(--dial-now)"
                    strokeWidth={2}
                    className="animate-dial-pulse"
                  />
                )}
              </g>
            );
          })}

          {typical && (
            <path
              aria-hidden
              d={typicalPath(typical.values, radius)}
              fill="none"
              stroke="var(--foreground)"
              strokeOpacity={0.5}
              strokeWidth={1.25}
              strokeDasharray="3 3"
            />
          )}

          {[0, 6, 12, 18].map((h) => {
            const [x, y] = polar(R1 + 12, h * 15);
            return (
              <text
                key={h}
                x={x}
                y={y}
                aria-hidden
                textAnchor="middle"
                dominantBaseline="middle"
                className="fill-(--chart-axis) text-[11px]"
              >
                {formatHour(h)}
              </text>
            );
          })}

          <g
            aria-hidden
            style={{ transform: `rotate(${handDeg}deg)`, transformOrigin: `${C}px ${C}px` }}
            className={cn(motion && "transition-transform duration-1000 ease-out")}
          >
            <line
              x1={C}
              y1={C - R0 + 6}
              x2={C}
              y2={C - R1 - 6}
              stroke="var(--dial-now)"
              strokeWidth={2}
              strokeLinecap="round"
            />
            <circle cx={C} cy={C - R1 - 6} r={3} fill="var(--dial-now)" />
          </g>

          {/* Hit targets last, so they sit above the marks. */}
          <g>
            {dial.hours.map((h) => {
              const [a1, a2] = hourAngles(h.hour);
              return (
                // biome-ignore lint/a11y/useSemanticElements: an SVG wedge can't be a <button>
                <path
                  key={h.hour}
                  ref={(el) => {
                    hitRefs.current[h.hour] = el;
                  }}
                  d={sector(R0 - 4, R1 + 4, a1 - 0.9, a2 + 0.9)}
                  role="button"
                  tabIndex={h.hour === selected ? 0 : -1}
                  aria-pressed={h.hour === selected}
                  aria-label={`${formatHour(h.hour)} to ${formatHour(h.hour + 1)}: ${h.hour > nowHour ? "not yet" : `${fmt(h.value)}, ${h.records} records`}`}
                  fill="transparent"
                  stroke={h.hour === selected ? "var(--foreground)" : "none"}
                  strokeOpacity={0.6}
                  strokeWidth={1}
                  className="cursor-pointer outline-none focus-visible:[stroke:var(--ring)] focus-visible:[stroke-opacity:1] focus-visible:[stroke-width:2.5]"
                  onPointerEnter={() => setSelected(h.hour)}
                  onFocus={() => setSelected(h.hour)}
                  onKeyDown={(event) => move(event, h.hour)}
                />
              );
            })}
          </g>
        </svg>

        <div className="pointer-events-none absolute inset-0 grid place-items-center">
          <div className="grid max-w-[34%] justify-items-center text-center">
            <span className="text-[11px] text-muted-foreground">today</span>
            <span className="text-lg leading-tight font-semibold sm:text-xl">
              <AnimatedNumber value={dial.total} format={fmt} />
            </span>
            <span className="num text-[11px] text-muted-foreground">
              {fmt(dial.hours[nowHour].value)} this hour
            </span>
          </div>
        </div>
      </div>

      <div className="grid min-w-0 gap-4">
        <HourReadout dial={dial} hour={hour} nowHour={nowHour} fmt={fmt} />
        <DialLegend dial={dial} typical={typical} />
        {measure === "cost" && Math.abs(dial.totalCost - ledgerCost) >= 0.005 && (
          <p className="text-xs text-muted-foreground">
            Hourly records add up to {formatCurrency(dial.totalCost)}; today’s ledger total is{" "}
            {formatCurrency(ledgerCost)}. The headline tiles use the ledger.
          </p>
        )}
      </div>
    </div>
  );
}

function HourReadout({
  dial,
  hour,
  nowHour,
  fmt,
}: {
  dial: Dial;
  hour: Dial["hours"][number];
  nowHour: number;
  fmt: (v: number) => string;
}) {
  const state = hour.hour > nowHour ? "not yet" : hour.hour === nowHour ? "so far" : null;
  return (
    <section aria-live="polite" className="rounded-lg border p-3">
      <h3 className="flex items-baseline justify-between gap-2 text-sm font-medium">
        {formatHour(hour.hour)} – {formatHour(hour.hour + 1)}
        {state && <span className="text-xs font-normal text-muted-foreground">{state}</span>}
      </h3>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">Est. cost</dt>
          <dd className="num font-semibold">{formatCurrency(hour.cost)}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Tokens</dt>
          <dd className="num font-semibold" title={formatInteger(hour.totalTokens)}>
            {formatCompact(hour.totalTokens)}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Records</dt>
          <dd className="num font-semibold">{formatInteger(hour.records)}</dd>
        </div>
      </dl>
      {hour.models.length > 0 && (
        <ul className="mt-2 grid gap-1 border-t pt-2 text-xs">
          {hour.models.slice(0, 4).map((m) => {
            const key = dial.series.some((s) => s.key === m.key) ? m.key : OTHER_KEY;
            return (
              <li key={m.key} className="flex items-center justify-between gap-3">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-[2px]"
                    style={{ background: seriesColor(dial, key) }}
                  />
                  <span className="truncate">{m.label}</span>
                </span>
                <span className="num shrink-0 text-muted-foreground">
                  {dial.measure === "cost" ? fmt(m.cost) : fmt(m.totalTokens)}
                </span>
              </li>
            );
          })}
          {hour.models.length > 4 && (
            <li className="text-muted-foreground">+{hour.models.length - 4} more</li>
          )}
        </ul>
      )}
    </section>
  );
}

function DialLegend({ dial, typical }: { dial: Dial; typical: TypicalDay | null }) {
  return (
    <ul className="grid gap-1.5 text-xs text-muted-foreground">
      <li>
        Bar length = {dial.measure === "cost" ? "estimated cost" : "tokens (nothing priced today)"},
        linear from the inner ring
      </li>
      {dial.series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="size-2.5 rounded-[3px]"
            style={{ background: seriesColor(dial, s.key) }}
          />
          {s.label}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span aria-hidden className="size-2.5 rounded-[3px] border-2 border-(--dial-now)" />
        Current hour, still filling
      </li>
      {typical && (
        <li className="flex items-center gap-1.5">
          <span aria-hidden className="h-0 w-3 border-t border-dashed border-foreground/60" />
          Typical: median of {typical.days} days
        </li>
      )}
    </ul>
  );
}

/** Staircase ring: an arc at each hour's typical radius, joined radially. */
function typicalPath(values: number[], radius: (v: number) => number): string {
  let d = "";
  values.forEach((v, h) => {
    const r = radius(v);
    const [x1, y1] = polar(r, h * 15);
    const [x2, y2] = polar(r, (h + 1) * 15);
    d += `${h === 0 ? "M" : "L"}${x1},${y1} A${r},${r} 0 0 1 ${x2},${y2} `;
  });
  return `${d}Z`;
}
