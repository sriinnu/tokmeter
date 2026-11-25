import type { ProviderSummary, StatbarSignals, TokmeterSummary } from "@sriinnu/tokmeter";
import { fetchDaemonJson, sanitizeDataLabel, TokmeterCore } from "@sriinnu/tokmeter";
import { Box, render, Text, useApp, useInput } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import { T } from "./theme.js";
import { CleanupView } from "./views/CleanupView.js";
import { DailyView } from "./views/DailyView.js";
import { ModelsView } from "./views/ModelsView.js";
import { OverviewView } from "./views/OverviewView.js";
import { StatsView } from "./views/StatsView.js";

const AUTO_REFRESH_MS = 15_000;

export type TabId = "overview" | "models" | "daily" | "stats" | "cleanup";

export const TABS: { id: TabId; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "daily", label: "Daily", key: "3" },
  { id: "stats", label: "Stats", key: "4" },
  { id: "cleanup", label: "Cleanup", key: "5" },
];

export interface TuiSnapshot {
  summary: TokmeterSummary;
  providers: ProviderSummary[];
  burnRatePerHour?: number;
  source: "daemon" | "local";
}

export interface TokmeterAppProps {
  initialSnapshot?: TuiSnapshot;
  loadSnapshot?: () => Promise<TuiSnapshot>;
  autoRefreshMs?: number;
  onExit?: () => void;
}

let _tuiDaemonNudged = false;
function maybeNudgeDaemon(): void {
  if (_tuiDaemonNudged || process.env.VITEST || process.env.TOKMETER_NO_AUTO_DAEMON === "1") return;
  _tuiDaemonNudged = true;
  try {
    void import("node:child_process").then(({ spawn }) => {
      const heapMb = process.env.TOKMETER_DAEMON_HEAP_MB ?? "6144";
      const entry = process.argv[1];
      if (!entry) return;
      spawn(process.execPath, [entry, "daemon", "start"], {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=${heapMb}`.trim(),
        },
      }).unref();
    });
  } catch {}
}

/**
 * Fetch the full TUI snapshot from the warm singleton daemon HTTP API in
 * parallel (`/api/summary`, `/api/providers`, `/api/statbar-signals`), honoring
 * `TOKMETER_DAEMON_PORT` and `daemon.token`. Returns `null` when unavailable.
 */
export async function fetchDaemonTuiSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  homeDir?: string
): Promise<TuiSnapshot | null> {
  const opts = {
    env,
    homeDir,
    probeTimeoutMs: 750,
    timeoutMs: 10_000,
    warmingTimeoutMs: 60_000,
    onDown: maybeNudgeDaemon,
  };
  const [summaryRes, providersRes, signalsRes] = await Promise.all([
    fetchDaemonJson<TokmeterSummary>("/api/summary", opts),
    fetchDaemonJson<ProviderSummary[]>("/api/providers", opts),
    fetchDaemonJson<StatbarSignals>("/api/statbar-signals", opts),
  ]);
  if (!summaryRes.ok) return null;
  const providers = providersRes.ok ? providersRes.data : [];
  const burnRatePerHour = signalsRes.ok
    ? signalsRes.data.burnRate.costPerHour
    : summaryRes.data.signals?.burnRate.costPerHour;
  return {
    summary: summaryRes.data,
    providers,
    burnRatePerHour,
    source: "daemon",
  };
}

export function TokmeterApp({
  initialSnapshot,
  loadSnapshot,
  autoRefreshMs = AUTO_REFRESH_MS,
  onExit,
}: TokmeterAppProps = {}) {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const coreRef = useRef<TokmeterCore | null>(null);
  const [snapshot, setSnapshot] = useState<TuiSnapshot | null>(initialSnapshot ?? null);
  const [loading, setLoading] = useState(!initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusWarning, setStatusWarning] = useState<string | null>(
    initialSnapshot ? summarizeWarnings(initialSnapshot.summary) : null
  );
  const snapshotRef = useRef<TuiSnapshot | null>(initialSnapshot ?? null);
  const refreshInFlightRef = useRef(false);

  const ensureLocalCore = useCallback(() => {
    if (!coreRef.current) coreRef.current = new TokmeterCore();
    return coreRef.current;
  }, []);

  const defaultLoadSnapshot = useCallback(async (): Promise<TuiSnapshot> => {
    const fromDaemon = await fetchDaemonTuiSnapshot();
    if (fromDaemon) return fromDaemon;
    const core = ensureLocalCore();
    await core.scan();
    const nextSummary = core.getSummary();
    return {
      summary: nextSummary,
      providers: core.getProviderBreakdown(),
      burnRatePerHour: nextSummary.signals?.burnRate.costPerHour,
      source: "local",
    };
  }, [ensureLocalCore]);

  const applySnapshot = useCallback((next: TuiSnapshot) => {
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);

  const refreshSummary = useCallback(
    async (mode: "initial" | "manual" | "auto") => {
      if (refreshInFlightRef.current) return;
      refreshInFlightRef.current = true;
      if (mode === "initial") setLoading(true);
      else setRefreshing(true);

      try {
        const loader = loadSnapshot ?? defaultLoadSnapshot;
        const next = await loader();
        applySnapshot(next);
        setError(null);
        setStatusWarning(summarizeWarnings(next.summary));
      } catch (refreshError) {
        const message = toErrorMessage(refreshError);
        if (snapshotRef.current) {
          setError(null);
          setStatusWarning(`Refresh failed — showing last good summary (${message}).`);
        } else {
          setError(message);
        }
      } finally {
        refreshInFlightRef.current = false;
        setLoading(false);
        setRefreshing(false);
      }
    },
    [applySnapshot, defaultLoadSnapshot, loadSnapshot]
  );

  useEffect(() => {
    if (initialSnapshot) return;
    void refreshSummary("initial");
  }, [initialSnapshot, refreshSummary]);

  useEffect(() => {
    if (!snapshot || loading || activeTab === "cleanup" || autoRefreshMs <= 0) {
      return;
    }
    const timer = setInterval(() => {
      void refreshSummary("auto");
    }, autoRefreshMs);
    return () => clearInterval(timer);
  }, [activeTab, autoRefreshMs, loading, refreshSummary, snapshot]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      if (onExit) onExit();
      else exit();
      return;
    }

    if (input === "r" && !loading) {
      void refreshSummary("manual");
      return;
    }

    const tab = TABS.find((t) => t.key === input);
    if (tab) setActiveTab(tab.id);

    if (key.leftArrow) {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      if (idx > 0) setActiveTab(TABS[idx - 1].id);
    }
    if (key.rightArrow) {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      if (idx < TABS.length - 1) setActiveTab(TABS[idx + 1].id);
    }
    if (key.tab) {
      const idx = TABS.findIndex((t) => t.id === activeTab);
      setActiveTab(TABS[(idx + 1) % TABS.length].id);
    }
  });

  if (loading) {
    return (
      <Box padding={2}>
        <Text color={T.accent}>Scanning session files...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box padding={2} flexDirection="column">
        <Text color={T.danger} bold>
          Error:
        </Text>
        <Text color={T.danger}>{error}</Text>
      </Box>
    );
  }

  if (!snapshot) return null;

  const { summary, providers, burnRatePerHour, source } = snapshot;
  const { stats, models, daily, projects, meta } = summary;

  return (
    <Box flexDirection="column" height="100%">
      {/* Tab bar */}
      <Box flexDirection="row" borderBottom borderStyle="single" paddingBottom={0}>
        {TABS.map((tab) => (
          <Box key={tab.id} paddingX={2}>
            <Text
              color={activeTab === tab.id ? T.accent : T.muted}
              bold={activeTab === tab.id}
              inverse={activeTab === tab.id}
            >
              {" "}
              {tab.key}:{tab.label}{" "}
            </Text>
          </Box>
        ))}
        <Box flexGrow={1} />
        <Text color={T.muted}> r:refresh q:quit </Text>
      </Box>

      {meta && (
        <Box flexDirection="column" paddingX={1} paddingY={1}>
          <Box>
            <Text color={getTodayStateColor(meta.todayState)} bold>
              {getTodayStateLabel(meta.todayState)}
            </Text>
            <Text color={T.muted}>
              {` • ${source === "daemon" ? "daemon" : "local"} • frozen through ${meta.stableThrough ?? "warming up"} • history ${formatHistorySource(meta.historySource)} • last scan ${formatTimestamp(meta.lastScanAt)}`}
            </Text>
            {refreshing && <Text color={T.warn}> • refreshing</Text>}
          </Box>
          {statusWarning && (
            <Text color={meta.todayState === "degraded" ? T.warn : T.muted}>{statusWarning}</Text>
          )}
        </Box>
      )}

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1}>
        {activeTab === "overview" && (
          <OverviewView
            stats={stats}
            models={models}
            daily={daily}
            providers={providers}
            burnRatePerHour={burnRatePerHour}
          />
        )}
        {activeTab === "models" && <ModelsView models={models} totalCost={stats.totalCost} />}
        {activeTab === "daily" && <DailyView daily={daily} />}
        {activeTab === "stats" && <StatsView stats={stats} daily={daily} />}
        {activeTab === "cleanup" && (
          <CleanupView
            core={ensureLocalCore()}
            projects={projects}
            onRefresh={() => refreshSummary("manual")}
          />
        )}
      </Box>
    </Box>
  );
}

export async function startTui(props?: TokmeterAppProps): Promise<void> {
  await render(<TokmeterApp {...props} />).waitUntilExit();
}

function summarizeWarnings(summary: TokmeterSummary): string | null {
  if (summary.meta.warnings.length === 0) {
    return null;
  }
  return summary.meta.warnings
    .map((warning) => sanitizeDataLabel(warning.message, 1024))
    .join(" · ");
}

function formatHistorySource(historySource: TokmeterSummary["meta"]["historySource"]): string {
  switch (historySource) {
    case "snapshot":
      return "snapshot cache";
    case "extended":
      return "snapshot + new days";
    case "rebuilt":
      return "fresh rebuild";
    default:
      return "warming up";
  }
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) return "waiting";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
  }).format(timestamp);
}

function getTodayStateColor(todayState: TokmeterSummary["meta"]["todayState"]): string {
  switch (todayState) {
    case "live":
      return T.success;
    case "degraded":
      return T.warn;
    default:
      return T.secondary;
  }
}

function getTodayStateLabel(todayState: TokmeterSummary["meta"]["todayState"]): string {
  switch (todayState) {
    case "live":
      return "Live today";
    case "degraded":
      return "Partial live";
    default:
      return "Snapshot only";
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
