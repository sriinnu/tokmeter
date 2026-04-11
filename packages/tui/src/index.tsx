#!/usr/bin/env node
/**
 * tokmeter-tui — Interactive terminal UI for token usage tracking.
 */

// Process-level error handlers — log only. Hard-exiting in the middle of an
// Ink render leaves the terminal in alt-screen mode with no cursor restored.
// We let Ink unmount cleanly via the in-app exit() path instead.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

import type { ProviderSummary, TokmeterSummary } from "@sriinnu/tokmeter";
import { TokmeterCore } from "@sriinnu/tokmeter";
import { Box, Text, render, useApp, useInput } from "ink";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { T } from "./theme.js";
import { CleanupView } from "./views/CleanupView.js";
import { DailyView } from "./views/DailyView.js";
import { ModelsView } from "./views/ModelsView.js";
import { OverviewView } from "./views/OverviewView.js";
import { StatsView } from "./views/StatsView.js";

const AUTO_REFRESH_MS = 15_000;

type TabId = "overview" | "models" | "daily" | "stats" | "cleanup";

const TABS: { id: TabId; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "daily", label: "Daily", key: "3" },
  { id: "stats", label: "Stats", key: "4" },
  { id: "cleanup", label: "Cleanup", key: "5" },
];

function App() {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [core] = useState(() => new TokmeterCore());
  const [summary, setSummary] = useState<TokmeterSummary | null>(null);
  const [providers, setProviders] = useState<ProviderSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusWarning, setStatusWarning] = useState<string | null>(null);
  const summaryRef = useRef<TokmeterSummary | null>(null);
  const refreshInFlightRef = useRef(false);

  const applySummary = useCallback(
    (nextSummary: TokmeterSummary) => {
      summaryRef.current = nextSummary;
      setSummary(nextSummary);
      setProviders(core.getProviderBreakdown());
    },
    [core]
  );

  const refreshSummary = useCallback(
    async (mode: "initial" | "manual" | "auto") => {
      if (refreshInFlightRef.current) {
        return;
      }

      refreshInFlightRef.current = true;
      if (mode === "initial") {
        setLoading(true);
      } else {
        setRefreshing(true);
      }

      try {
        await core.scan();
        const nextSummary = core.getSummary();
        applySummary(nextSummary);
        setError(null);
        setStatusWarning(summarizeWarnings(nextSummary));
      } catch (refreshError) {
        const message = toErrorMessage(refreshError);

        if (summaryRef.current) {
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
    [applySummary, core]
  );

  useEffect(() => {
    void refreshSummary("initial");
  }, [refreshSummary]);

  useEffect(() => {
    if (!summary || loading || activeTab === "cleanup") {
      return;
    }

    const timer = setInterval(() => {
      void refreshSummary("auto");
    }, AUTO_REFRESH_MS);

    return () => {
      clearInterval(timer);
    };
  }, [activeTab, loading, refreshSummary, summary]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
      return;
    }

    if (input === "r" && !loading) {
      void refreshSummary("manual");
      return;
    }

    // Tab switching
    const tab = TABS.find((t) => t.key === input);
    if (tab) setActiveTab(tab.id);

    // Arrow keys
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

  const stats = summary?.stats ?? null;
  const models = summary?.models ?? [];
  const daily = summary?.daily ?? [];
  const projects = summary?.projects ?? [];
  const meta = summary?.meta ?? null;

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

  // After this point, stats/models/daily are guaranteed non-null/non-empty.
  if (!stats) return null;

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
              {` • frozen through ${meta.stableThrough ?? "warming up"} • history ${formatHistorySource(meta.historySource)} • last scan ${formatTimestamp(meta.lastScanAt)}`}
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
          <OverviewView stats={stats} models={models} daily={daily} providers={providers} />
        )}
        {activeTab === "models" && <ModelsView models={models} totalCost={stats.totalCost} />}
        {activeTab === "daily" && <DailyView daily={daily} />}
        {activeTab === "stats" && <StatsView stats={stats} daily={daily} />}
        {activeTab === "cleanup" && (
          <CleanupView core={core} projects={projects} onRefresh={() => refreshSummary("manual")} />
        )}
      </Box>
    </Box>
  );
}

function summarizeWarnings(summary: TokmeterSummary): string | null {
  if (summary.meta.warnings.length === 0) {
    return null;
  }

  return summary.meta.warnings.map((warning) => warning.message).join(" · ");
}

function formatHistorySource(historySource: TokmeterSummary["meta"]["historySource"]): string {
  switch (historySource) {
    case "snapshot":
      return "snapshot cache";
    case "rebuilt":
      return "fresh rebuild";
    default:
      return "warming up";
  }
}

function formatTimestamp(timestamp: number): string {
  if (!timestamp) {
    return "waiting";
  }

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

render(React.createElement(App)).waitUntilExit();
