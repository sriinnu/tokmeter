/** Live aggregate data from the app-owned, authenticated dashboard proxy. */

import { useEffect, useState } from "react";

interface ModelBreakdown {
  model: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
}

interface ProviderBreakdown {
  provider: string;
  cost: number;
  sessions: number;
}

interface AggregatedStats {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheTokens: number;
  sessions: number;
  providers: string[];
  byModel: ModelBreakdown[];
  byProvider: ProviderBreakdown[];
}

export type LiveConnectionStatus = "connecting" | "connected" | "disconnected";

export interface LiveData {
  status: LiveConnectionStatus;
  aggregated: AggregatedStats | null;
  lastUpdate: number | null;
}

const POLL_INTERVAL_MS = 2_000;
const MAX_RETRY_MS = 30_000;

/**
 * The browser never receives the daemon credential. The dashboard child reads
 * it from the owner's private directory and proxies this same-origin request.
 */
export function useLiveData(): LiveData {
  const [status, setStatus] = useState<LiveConnectionStatus>("connecting");
  const [aggregated, setAggregated] = useState<AggregatedStats | null>(null);
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  useEffect(() => {
    let stopped = false;
    let retryMs = POLL_INTERVAL_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    async function poll() {
      controller = new AbortController();
      try {
        const response = await fetch("/api/live", {
          cache: "no-store",
          credentials: "same-origin",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Live data unavailable");
        const data = (await response.json()) as { aggregated?: AggregatedStats };
        if (!data.aggregated || !Array.isArray(data.aggregated.byModel)) {
          throw new Error("Invalid live data");
        }
        if (stopped) return;
        setAggregated(data.aggregated);
        setLastUpdate(Date.now());
        setStatus("connected");
        retryMs = POLL_INTERVAL_MS;
      } catch {
        if (stopped) return;
        setStatus("disconnected");
        retryMs = Math.min(retryMs * 2, MAX_RETRY_MS);
      }
      if (!stopped) timer = setTimeout(poll, retryMs);
    }

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, []);

  return { status, aggregated, lastUpdate };
}
