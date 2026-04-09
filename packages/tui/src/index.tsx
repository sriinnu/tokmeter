#!/usr/bin/env node
/**
 * tokmeter-tui — Interactive terminal UI for token usage tracking.
 */

// Process-level error handlers
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled rejection:", reason);
  process.exit(1);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  process.exit(1);
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: core is stable, only recompute on load
  const stats = useMemo(() => core.getStats(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: core is stable, only recompute on load
  const models = useMemo(() => core.getModelCosts(), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: core is stable, only recompute on load
  const daily = useMemo(() => core.getDailyBreakdown(), []);

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
