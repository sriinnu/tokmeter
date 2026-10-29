export {
  formatDashboardCostPerMillion as formatCostPerMillion,
  formatDashboardCurrency as formatCurrencyCompact,
  formatDashboardDate as formatShortDate,
  formatDashboardNumber as formatCompact,
  formatDashboardPercent as formatPercent,
  formatDashboardTimestamp as formatTimestamp,
} from "../pages/dashboard/dashboardFormatters.js";

const usd2 = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const grouped = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * Dollars to the cent. Spend under a cent says "<$0.01" rather than rounding
 * to "$0.00", which would read as no spend at all.
 */
export function formatCurrency(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (value > 0 && value < 0.005) return "<$0.01";
  return usd2.format(value);
}

/** Exact token counts with digit grouping, for tables and tooltips. */
export function formatInteger(value: number): string {
  return Number.isFinite(value) ? grouped.format(value) : "—";
}

/** Signed relative change, or null when there is no meaningful baseline. */
export function relativeChange(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) return null;
  return (current - previous) / previous;
}

export function formatSignedPercent(ratio: number): string {
  const pct = ratio * 100;
  const body = Math.abs(pct) >= 10 ? Math.abs(pct).toFixed(0) : Math.abs(pct).toFixed(1);
  return `${pct > 0 ? "+" : pct < 0 ? "−" : "±"}${body}%`;
}

/** Long form of a YYYY-MM-DD key, e.g. "Tue, 14 Oct 2026". */
export function formatLongDate(key: string): string {
  const d = new Date(`${key}T00:00:00`);
  if (Number.isNaN(d.getTime())) return key;
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(d);
}

export function formatHour(hour: number): string {
  const h = hour % 24;
  if (h === 0) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

export function plural(count: number, noun: string): string {
  return `${formatInteger(count)} ${noun}${count === 1 ? "" : "s"}`;
}

/** Axis ticks: short and never "$0.0000" (the tile formatter's sub-dollar precision). */
export function formatAxisCurrency(value: number): string {
  if (value === 0) return "$0";
  const abs = Math.abs(value);
  if (abs >= 1000) return `$${(value / 1000).toFixed(abs >= 10_000 ? 0 : 1)}K`;
  if (abs >= 10) return `$${value.toFixed(0)}`;
  if (abs >= 1) return `$${value.toFixed(1)}`;
  return `$${value.toFixed(2)}`;
}
