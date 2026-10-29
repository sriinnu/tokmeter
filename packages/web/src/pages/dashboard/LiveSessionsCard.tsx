import { CircleDot, Radio, Unplug } from "lucide-react";
import { BarList } from "../../charts/BarList.js";
import { LedgerArt } from "../../components/art/LedgerArt.js";
import { Badge } from "../../components/ui/badge.js";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import type { LiveData } from "../../hooks/useLiveData.js";
import { useNow } from "../../hooks/useNow.js";
import { formatCompact, formatCurrency, formatInteger } from "../../lib/format.js";
import { selectLivePanelState } from "../../lib/live-state.js";

const BADGE = {
  streaming: { variant: "live", icon: Radio, label: "Streaming" },
  idle: { variant: "outline", icon: CircleDot, label: "Connected · idle" },
  connecting: { variant: "outline", icon: Radio, label: "Connecting" },
  offline: { variant: "outline", icon: Unplug, label: "Daemon offline" },
} as const;

/**
 * The daemon's in-flight session view. Kept visibly apart from the ledger:
 * these numbers describe open sessions, not saved history, and are never
 * added to any total on the page.
 */
export function LiveSessionsCard({ live }: { live: LiveData }) {
  const state = selectLivePanelState(live);
  const badge = BADGE[state];
  const aggregated = state === "streaming" ? live.aggregated : null;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Live sessions</CardTitle>
          <CardDescription>Daemon view of open sessions — not added to any total</CardDescription>
        </div>
        <Badge variant={badge.variant}>
          <badge.icon aria-hidden />
          {badge.label}
        </Badge>
      </CardHeader>
      <CardContent className="grid gap-4">
        {aggregated ? (
          <>
            <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              <Stat label="Sessions" value={formatInteger(aggregated.sessions)} />
              <Stat label="Est. cost" value={formatCurrency(aggregated.totalCost)} />
              <Stat label="Input" value={formatCompact(aggregated.totalInputTokens)} />
              <Stat label="Output" value={formatCompact(aggregated.totalOutputTokens)} />
            </dl>
            <BarList
              label="Live sessions by model"
              items={aggregated.byModel.map((m) => ({
                key: m.model,
                label: m.model,
                value: m.cost,
                valueText: formatCurrency(m.cost),
                detail: `${formatCompact(m.inputTokens)} in · ${formatCompact(m.outputTokens)} out`,
              }))}
            />
            {live.lastUpdate && <LastUpdate at={live.lastUpdate} />}
          </>
        ) : (
          <div className="flex items-center gap-4">
            <LedgerArt kind={state === "idle" ? "empty" : "offline"} className="h-14" />
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {state === "idle"
                  ? "No live sessions reporting"
                  : state === "connecting"
                    ? "Reconnecting to the daemon…"
                    : "Daemon offline"}
              </p>
              <p className="text-xs text-muted-foreground">
                {state === "idle"
                  ? "Sessions appear here while an agent with the tokmeter statusline is running."
                  : "History stays available from the saved summary; this panel wakes up when the daemon is reachable."}
              </p>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Ticks on its own so the rest of the dashboard doesn't re-render every second.
function LastUpdate({ at }: { at: number }) {
  const now = useNow(1000);
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  return (
    <p className="num text-xs text-muted-foreground">
      Last update {seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m`} ago
    </p>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="num font-semibold">{value}</dd>
    </div>
  );
}
