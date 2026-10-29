import { AlertTriangle, ChevronDown, CircleDot, Lock, Radio } from "lucide-react";
import type { LiveConnectionStatus } from "../hooks/useLiveData.js";
import type { TokmeterScanMeta, TokmeterSummarySource } from "../hooks/useTokmeterData.js";
import { cn } from "../lib/utils.js";
import { Badge } from "./ui/badge.js";

interface SummaryStatusBannerProps {
  meta: TokmeterScanMeta;
  warning: string | null;
  lastLoadedAt: number | null;
  summarySource: TokmeterSummarySource | null;
  daemonStatus: LiveConnectionStatus;
}

/**
 * Summary freshness, the sealed-history boundary, and any degraded live-state
 * warnings, without blocking the rest of the dashboard. Healthy state folds to
 * one line; anything degraded opens itself so it can't be missed.
 */
export function SummaryStatusBanner({
  meta,
  warning,
  lastLoadedAt,
  summarySource,
  daemonStatus,
}: SummaryStatusBannerProps) {
  const tone = getTodayStateTone(meta.todayState);
  const joinedMetaWarnings = meta.warnings.map((entry) => entry.message).join(" · ");
  // A refresh failure replaces the meta summary in `warning`; show it on its own.
  const extraWarning = warning && warning !== joinedMetaWarnings ? warning : null;
  const hasWarnings = meta.warnings.length > 0 || extraWarning !== null;
  const degraded = meta.todayState !== "live" || hasWarnings;
  const historyMessage = meta.stableThrough
    ? `History sealed through ${formatDate(meta.stableThrough)}`
    : "Historical snapshot is warming up";

  return (
    <details
      open={degraded}
      className={cn("group rounded-xl border bg-card text-sm", degraded && "border-warning/50")}
    >
      <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl px-4 py-2.5 sm:px-5 [&::-webkit-details-marker]:hidden">
        <span className="flex min-w-0 items-center gap-2">
          <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{historyMessage}</span>
        </span>
        <Badge variant={tone.variant}>
          <tone.icon aria-hidden /> {tone.label}
        </Badge>
        {hasWarnings && (
          <Badge variant="warning">
            <AlertTriangle aria-hidden />
            {meta.warnings.length + (extraWarning ? 1 : 0)} warning
            {meta.warnings.length + (extraWarning ? 1 : 0) === 1 ? "" : "s"}
          </Badge>
        )}
        <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
          Scanned {formatTimestamp(meta.lastScanAt)}
          <ChevronDown
            className="size-3.5 transition-transform group-open:rotate-180"
            aria-hidden
          />
          <span className="sr-only">Toggle summary details</span>
        </span>
      </summary>

      <div className="grid gap-3 border-t px-4 py-3 sm:px-5">
        <p className="text-xs text-muted-foreground">{getTodayStateMessage(meta.todayState)}</p>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-5">
          <Metric label="Summary source" value={getSummarySourceLabel(summarySource)} />
          <Metric label="Daemon stream" value={getDaemonStatusLabel(daemonStatus)} />
          <Metric label="History source" value={getHistorySourceLabel(meta.historySource)} />
          <Metric label="Last scan" value={formatTimestamp(meta.lastScanAt)} />
          <Metric label="Browser refresh" value={formatTimestamp(lastLoadedAt)} />
        </dl>
        {hasWarnings && (
          <ul className="grid gap-1.5 rounded-lg border border-warning/40 bg-warning/5 px-3 py-2 text-xs">
            {extraWarning && <WarningItem message={extraWarning} />}
            {meta.warnings.map((entry, index) => (
              <WarningItem
                // biome-ignore lint/suspicious/noArrayIndexKey: warnings have no id and may repeat
                key={`${entry.scope}-${index}`}
                message={entry.message}
                scope={entry.provider ? `${entry.scope} · ${entry.provider}` : entry.scope}
              />
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

function WarningItem({ message, scope }: { message: string; scope?: string }) {
  return (
    <li className="flex items-start gap-2">
      <AlertTriangle className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
      <span className="min-w-0 break-words">
        {scope && <span className="mr-1 font-medium uppercase tracking-wide">{scope}</span>}
        {message}
      </span>
    </li>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{value}</dd>
    </div>
  );
}

function getTodayStateTone(todayState: TokmeterScanMeta["todayState"]) {
  switch (todayState) {
    case "live":
      return { label: "Today live", variant: "live" as const, icon: CircleDot };
    case "degraded":
      return { label: "Today partial", variant: "warning" as const, icon: AlertTriangle };
    default:
      return { label: "Snapshot only", variant: "warning" as const, icon: Radio };
  }
}

function getTodayStateMessage(todayState: TokmeterScanMeta["todayState"]): string {
  switch (todayState) {
    case "live":
      return "Today is updating live. Sealed days are immutable; a rescan can only ever add to them.";
    case "degraded":
      return "Sealed history is stable, but one or more live providers are temporarily unavailable, so today may be incomplete.";
    default:
      return "Showing the last known summary only. Today will update again when a fresh scan succeeds.";
  }
}

function getHistorySourceLabel(historySource: TokmeterScanMeta["historySource"]): string {
  switch (historySource) {
    case "snapshot":
      return "Snapshot cache";
    case "extended":
      return "Snapshot + new days";
    case "rebuilt":
      return "Fresh rebuild";
    default:
      return "Not ready";
  }
}

function getSummarySourceLabel(summarySource: TokmeterSummarySource | null): string {
  switch (summarySource) {
    case "live-api":
      return "Live API";
    case "cached-api":
      return "Persisted cache";
    case "static-cache":
      return "Static data.json";
    case "memory-cache":
      return "Browser memory cache";
    default:
      return "Waiting for data";
  }
}

function getDaemonStatusLabel(daemonStatus: LiveConnectionStatus): string {
  switch (daemonStatus) {
    case "connected":
      return "Running";
    case "connecting":
      return "Connecting";
    default:
      return "Offline";
  }
}

function formatDate(value: string): string {
  const parsed = new Date(`${value}T00:00:00`);
  return Number.isNaN(parsed.getTime())
    ? value
    : new Intl.DateTimeFormat(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
      }).format(parsed);
}

function formatTimestamp(value: number | null): string {
  if (!value) {
    return "—";
  }

  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(value);
}
