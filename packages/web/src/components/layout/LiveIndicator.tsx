import type { LiveConnectionStatus } from "../../hooks/useLiveData.js";
import { cn } from "../../lib/utils.js";

const LABEL: Record<LiveConnectionStatus, string> = {
  connected: "Daemon live",
  connecting: "Connecting",
  disconnected: "Daemon offline",
};

/**
 * Connection state of the local daemon stream. The dot is backed by a text
 * label, so state never relies on colour alone.
 */
export function LiveIndicator({
  status,
  sessions,
  compact = false,
}: {
  status: LiveConnectionStatus;
  sessions: number;
  compact?: boolean;
}) {
  const live = status === "connected";
  return (
    <output
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 rounded-md border bg-card px-2.5 py-1.5 text-xs",
        live ? "text-foreground" : "text-muted-foreground"
      )}
    >
      <span className="relative flex size-2" aria-hidden>
        {live && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-live-dot opacity-60 in-data-[motion=off]:hidden" />
        )}
        <span
          className={cn(
            "relative inline-flex size-2 rounded-full",
            live
              ? "bg-live-dot"
              : status === "connecting"
                ? "bg-warning-dot"
                : "bg-muted-foreground/50"
          )}
        />
      </span>
      <span className={cn(compact && "sr-only sm:not-sr-only")}>{LABEL[status]}</span>
      {live && sessions > 0 && (
        <span className="num text-muted-foreground">
          · {sessions} {sessions === 1 ? "session" : "sessions"}
        </span>
      )}
    </output>
  );
}
