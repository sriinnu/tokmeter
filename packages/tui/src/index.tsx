#!/usr/bin/env node
/**
 * tokmeter-tui — Interactive terminal UI for token usage tracking.
 */

import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput, useApp, render } from "ink";
import { TokmeterCore } from "@tokmeter/core";
import { OverviewView } from "./views/OverviewView.js";
import { ModelsView } from "./views/ModelsView.js";
import { DailyView } from "./views/DailyView.js";
import { StatsView } from "./views/StatsView.js";

type TabId = "overview" | "models" | "daily" | "stats";

const TABS: { id: TabId; label: string; key: string }[] = [
  { id: "overview", label: "Overview", key: "1" },
  { id: "models", label: "Models", key: "2" },
  { id: "daily", label: "Daily", key: "3" },
  { id: "stats", label: "Stats", key: "4" },
];

function App() {
  const { exit } = useApp();
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [core] = useState(() => new TokmeterCore());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    core.scan().then(() => setLoading(false)).catch((err: Error) => {
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
        <Text color="cyan">Scanning session files...</Text>
      </Box>
    );
  }

  if (error) {
    return (
      <Box padding={2} flexDirection="column">
        <Text color="red" bold>
          Error:
        </Text>
        <Text color="red">{error}</Text>
      </Box>
    );
  }

  const stats = useMemo(() => core.getStats(), [loading]);
  const models = useMemo(() => core.getModelCosts(), [loading]);
  const daily = useMemo(() => core.getDailyBreakdown(), [loading]);

  return (
    <Box flexDirection="column" height="100%">
      {/* Tab bar */}
      <Box flexDirection="row" borderBottom borderStyle="single" paddingBottom={0}>
        {TABS.map((tab) => (
          <Box key={tab.id} paddingX={2}>
            <Text
              color={activeTab === tab.id ? "cyan" : "gray"}
              bold={activeTab === tab.id}
              inverse={activeTab === tab.id}
            >
              {" "}
              {tab.key}:{tab.label}{" "}
            </Text>
          </Box>
        ))}
        <Box flexGrow={1} />
        <Text color="gray"> q:quit </Text>
      </Box>

      {/* Content area */}
      <Box flexDirection="column" flexGrow={1}>
        {activeTab === "overview" && <OverviewView core={core} />}
        {activeTab === "models" && <ModelsView models={models} totalCost={stats.totalCost} />}
        {activeTab === "daily" && <DailyView daily={daily} />}
        {activeTab === "stats" && <StatsView stats={stats} daily={daily} />}
      </Box>
    </Box>
  );
}

render(React.createElement(App)).waitUntilExit();
