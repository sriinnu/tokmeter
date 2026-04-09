#!/usr/bin/env node
/**
 * tokmeter-tui — Interactive terminal UI for token usage tracking.
 */

// Process-level error handlers — log only. Hard-exiting in the middle of an
// Ink render leaves the terminal in alt-screen mode with no cursor restored.
// We let Ink unmount cleanly via the in-app exit() path instead.
process.on("unhandledRejection", (reason) => {
  // biome-ignore lint/suspicious/noConsole: error path
  console.error("Unhandled rejection:", reason);
});

process.on("uncaughtException", (error) => {
  // biome-ignore lint/suspicious/noConsole: error path
  console.error("Uncaught exception:", error);
});

import { TokmeterCore } from "@sriinnu/tokmeter-core";
import { Box, Text, render, useApp, useInput } from "ink";
import React, { useState, useEffect, useMemo } from "react";
import { T } from "./theme.js";
import { DailyView } from "./views/DailyView.js";
import { ModelsView } from "./views/ModelsView.js";
import { OverviewView } from "./views/OverviewView.js";
import { StatsView } from "./views/StatsView.js";
import { CleanupView } from "./views/CleanupView.js";

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    core
      .scan()
      .then(() => setLoading(false))
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [core]);

  useInput((input, key) => {
    if (input === "q" || key.escape) {
      exit();
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

  // Hooks must run unconditionally — never after early returns.
  // We compute these even during loading so React's hook order is stable.
  // The values are only consumed after `loading` flips false.
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when scan completes
  const stats = useMemo(() => (loading ? null : core.getStats()), [loading]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when scan completes
  const models = useMemo(() => (loading ? [] : core.getModelCosts()), [loading]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recompute when scan completes
  const daily = useMemo(() => (loading ? [] : core.getDailyBreakdown()), [loading]);

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
        <Text color={T.muted}> q:quit </Text>
      </Box>

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1}>
        {activeTab === "overview" && <OverviewView core={core} />}
        {activeTab === "models" && <ModelsView models={models} totalCost={stats.totalCost} />}
        {activeTab === "daily" && <DailyView daily={daily} />}
        {activeTab === "stats" && <StatsView stats={stats} daily={daily} />}
        {activeTab === "cleanup" && <CleanupView core={core} />}
      </Box>
    </Box>
  );
}

render(React.createElement(App)).waitUntilExit();
