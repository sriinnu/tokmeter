/**
 * Format a numeric value using compact notation for tokens, records, and counts.
 */
export function formatDashboardNumber(value: number): string {
  if (value >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1)}B`;
  }

  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1)}M`;
  }

  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1)}K`;
  }

  return value.toFixed(0);
}

/**
 * Format a dollar amount for dashboard cards and tables.
 */
export function formatDashboardCurrency(value: number): string {
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : value >= 1 ? 2 : 4;
  return `$${value.toFixed(precision)}`;
}

/**
 * Format a ratio into a readable percentage label.
 */
export function formatDashboardPercent(value: number): string {
  if (!Number.isFinite(value)) {
    return "0%";
  }

  const percent = value * 100;
  return `${percent >= 10 ? percent.toFixed(0) : percent.toFixed(1)}%`;
}

/**
 * Format a spend-per-million-tokens ratio when token volume exists.
 */
export function formatDashboardCostPerMillion(value: number | null): string {
  if (value === null || !Number.isFinite(value)) {
    return "—";
  }

  return `$${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)}/1M`;
}

/**
 * Format a YYYY-MM-DD local date key into a compact label.
 */
export function formatDashboardDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
  }).format(parsed);
}

/**
 * Format an epoch timestamp into a compact local date/time label.
 */
export function formatDashboardTimestamp(value: number): string {
  if (!value) {
    return "Awaiting data";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(value);
}
