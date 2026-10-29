import * as React from "react";
import * as RechartsPrimitive from "recharts";
import { cn } from "../../lib/utils.js";

/**
 * shadcn/ui chart pattern: a config maps each series key to a label and a
 * colour, the container exposes them as `--color-<key>` CSS variables, and
 * chart marks reference `var(--color-<key>)`. Series colours therefore follow
 * the theme tokens instead of being baked into each chart.
 */
export type ChartConfig = Record<string, { label: string; color?: string }>;

const ChartContext = React.createContext<ChartConfig | null>(null);

function useChartConfig(): ChartConfig {
  const config = React.useContext(ChartContext);
  if (!config) throw new Error("Chart components must be rendered inside <ChartContainer>");
  return config;
}

export function ChartContainer({
  config,
  className,
  children,
  style,
  ...props
}: React.ComponentProps<"div"> & {
  config: ChartConfig;
  children: React.ComponentProps<typeof RechartsPrimitive.ResponsiveContainer>["children"];
}) {
  const vars = Object.fromEntries(
    Object.entries(config)
      .filter(([, entry]) => entry.color)
      .map(([key, entry]) => [`--color-${key}`, entry.color])
  ) as React.CSSProperties;

  return (
    <ChartContext.Provider value={config}>
      <div
        className={cn(
          "w-full text-xs [&_.recharts-cartesian-axis-tick_text]:fill-(--chart-axis) [&_.recharts-cartesian-grid_line]:stroke-(--chart-grid) [&_.recharts-reference-line_line]:stroke-(--chart-axis) [&_.recharts-surface]:outline-none [&_.recharts-wrapper]:outline-none",
          className
        )}
        style={{ ...vars, ...style }}
        {...props}
      >
        <RechartsPrimitive.ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {children}
        </RechartsPrimitive.ResponsiveContainer>
      </div>
    </ChartContext.Provider>
  );
}

export const ChartTooltip = RechartsPrimitive.Tooltip;

interface TooltipEntry {
  dataKey?: string | number;
  name?: string | number;
  value?: number | string;
  color?: string;
  payload?: Record<string, unknown>;
}

/**
 * Tooltip body. Text stays in foreground ink; only the swatch carries the
 * series colour, so identity never rides on coloured text.
 */
export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  valueFormatter,
  footer,
  hideZero = false,
}: {
  active?: boolean;
  payload?: readonly TooltipEntry[];
  label?: string | number;
  labelFormatter?: (label: string, payload: readonly TooltipEntry[]) => React.ReactNode;
  valueFormatter?: (value: number, key: string) => string;
  footer?: (payload: readonly TooltipEntry[]) => React.ReactNode;
  hideZero?: boolean;
}) {
  const config = useChartConfig();
  if (!active || !payload?.length) return null;
  const rows = hideZero ? payload.filter((entry) => Number(entry.value) !== 0) : payload;

  return (
    <div className="min-w-40 rounded-md border bg-popover px-2.5 py-2 text-xs text-popover-foreground shadow-md">
      {label !== undefined && (
        <div className="mb-1.5 font-medium">
          {labelFormatter ? labelFormatter(String(label), payload) : label}
        </div>
      )}
      <div className="grid gap-1">
        {rows.map((entry) => {
          const key = String(entry.dataKey ?? entry.name ?? "");
          const value = Number(entry.value ?? 0);
          return (
            <div key={key} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-muted-foreground">
                <span
                  aria-hidden
                  className="size-2 shrink-0 rounded-[2px]"
                  style={{ background: entry.color ?? `var(--color-${key})` }}
                />
                {config[key]?.label ?? key}
              </span>
              <span className="num font-medium">
                {valueFormatter ? valueFormatter(value, key) : value.toLocaleString()}
              </span>
            </div>
          );
        })}
      </div>
      {footer?.(payload)}
    </div>
  );
}

/**
 * Legend listing configured series in config order. Takes the config directly
 * so it can sit outside the chart's ResponsiveContainer.
 */
export function ChartLegend({
  config,
  keys,
  className,
}: {
  config: ChartConfig;
  keys?: string[];
  className?: string;
}) {
  const entries = (keys ?? Object.keys(config)).filter((key) => config[key]?.color);
  return (
    <ul className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-xs", className)}>
      {entries.map((key) => (
        <li key={key} className="flex items-center gap-1.5 text-muted-foreground">
          <span
            aria-hidden
            className="size-2.5 rounded-[3px]"
            style={{ background: config[key].color }}
          />
          {config[key].label}
        </li>
      ))}
    </ul>
  );
}
